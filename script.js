// Immediately apply Quick Save view class if needed (prevents UI flash on refresh)
if (localStorage.getItem('isViewingGlobalUnassigned') === 'true') {
    document.body.classList.add('quick-save-view');
}

// Global unassigned project ID (special project for tiles not assigned to any dashboard)
const GLOBAL_UNASSIGNED_ID = 'global-unassigned';

let lifetilesBC = null;

let __ltRefreshScheduled = false;

function __ltScheduleRefresh() {
  if (__ltRefreshScheduled) return;
  __ltRefreshScheduled = true;
  setTimeout(() => {
    __ltRefreshScheduled = false;
    window.__lifetilesRefresh?.();
  }, 50);
}

// HTML escape utility to prevent XSS
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}


// --- internal URL helpers ---
// Only allow http/https URLs to prevent javascript:/data: execution
function isInternalUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol !== 'http:' && url.protocol !== 'https:';
  } catch { return true; } // invalid/blank -> treat as internal
}

// =============================================================================
// FAVICON MODULE - Consolidated favicon discovery and caching
// =============================================================================

const FAVICON_TTL_MS = 86400000; // 24 hours
const sessionFaviconCache = new Map();
const __ltOnsiteBlocked = new Set(); // Tracks hosts that block direct favicon access

// Check if a favicon URL is from a deprecated/problematic service
function isDeprecatedFavicon(url) {
    if (!url || typeof url !== 'string') return true;
    return (
        url.includes('chrome-extension://') ||
        /(?:^|\/\/)t\d*\.gstatic\.com\/favicon/i.test(url) ||
        /(?:^|\/\/)www\.google\.com\/s2\/favicons.*sz=16/i.test(url) ||
        /favicon.*googleapis/i.test(url)
    );
}

// One-time cleanup: remove legacy cached favicons that point to deprecated services
async function purgeLegacyFavicons() {
    try {
        const rows = await db.favicons.toArray();
        for (const row of rows) {
            if (isDeprecatedFavicon(row?.favicon)) {
                await db.favicons.delete(row.hostname);
                sessionFaviconCache.delete(row.hostname);
            }
        }
    } catch {}
}

// Probe an image URL by loading it (avoids CORS/ORB issues with fetch)
function probeImage(src, minSize = 16, timeout = 900) {
    return new Promise((resolve) => {
        const img = new Image();
        let done = false;
        const finish = (result) => { if (!done) { done = true; resolve(result); } };
        const timer = setTimeout(() => finish(null), timeout);
        img.onload = () => {
            clearTimeout(timer);
            const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
            finish((w >= minSize && h >= minSize) ? src : null);
        };
        img.onerror = () => { clearTimeout(timer); finish(null); };
        img.referrerPolicy = 'no-referrer';
        img.src = src;
    });
}

// Try to get favicon from an open tab with matching URL/host
async function tryTabFavicon(pageUrl, minSize = 16) {
    try {
        if (!chrome?.tabs?.query || !pageUrl) return null;
        const wanted = new URL(pageUrl);
        const tabs = await chrome.tabs.query({});

        // Prefer exact URL match, then same-host match
        const exact = tabs.find(t => { try { return new URL(t.url).href === wanted.href; } catch { return false; } });
        const sameHost = tabs.find(t => { try { return new URL(t.url).hostname === wanted.hostname; } catch { return false; } });
        const favUrl = exact?.favIconUrl || sameHost?.favIconUrl;

        if (!favUrl || favUrl.includes('chrome-extension://')) return null;
        return await probeImage(favUrl, minSize);
    } catch { return null; }
}

// Get eTLD+1 (e.g., news.example.com → example.com)
function getApexDomain(host) {
    const parts = (host || '').split('.').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

// Build host variants (with/without www)
function buildHostVariants(host) {
    if (!host) return [];
    const parts = host.split('.').filter(Boolean);
    const variants = new Set([host]);
    if (parts[0] === 'www') variants.add(parts.slice(1).join('.'));
    else if (parts.length === 2) variants.add(`www.${host}`);
    return Array.from(variants);
}

// Main favicon discovery function
async function loadFaviconForHost(hostname, pageUrl) {
    if (!hostname) return null;
    if (sessionFaviconCache.has(hostname)) return sessionFaviconCache.get(hostname) || null;

    const MIN_PX = 16, PREF_PX = 24, S2_MIN_PX = 24;
    let found = null;

    // Normalize page URL
    let normalizedUrl = null;
    try { normalizedUrl = pageUrl ? new URL(pageUrl).href : `https://${hostname}`; }
    catch { normalizedUrl = `https://${hostname}`; }

    // Helper to probe with S2 globe detection (S2 returns 16px globe for unknown sites)
    const probeS2 = async (url) => {
        const result = await probeImage(url, S2_MIN_PX, 900);
        return result; // Size check handles 16px globe rejection
    };

    // Helper to probe with fast-fail detection for onsite URLs
    const probeOnsite = async (url, min) => {
        const t0 = performance.now();
        const result = await probeImage(url, min, 900);
        if (!result && performance.now() - t0 < 150 && url.startsWith(`https://${hostname}/`)) {
            __ltOnsiteBlocked.add(hostname);
        }
        return result;
    };

    const hostVariants = buildHostVariants(hostname);
    const apexDomain = getApexDomain(hostname);

    // Stage order: tab → onsite → services
    // Onsite first for privacy (no third-party learns your bookmarks)
    // and accuracy (most sites serve favicons at standard paths).
    // Third-party services (S2, icon.horse) are last resort.

    // 1) Tab favicon (Chrome already resolved the URL)
    found = await tryTabFavicon(normalizedUrl, PREF_PX);
    if (!found) found = await tryTabFavicon(normalizedUrl, MIN_PX);

    // 2) Onsite (direct from the site - no third-party involved)
    if (!found && !__ltOnsiteBlocked.has(hostname)) {
        const paths = ['/favicon.svg', '/apple-touch-icon.png', '/favicon.ico', '/favicon-32x32.png'];
        for (const h of hostVariants) {
            for (const path of paths) {
                found = await probeOnsite(`https://${h}${path}`, PREF_PX);
                if (!found) found = await probeOnsite(`https://${h}${path}`, MIN_PX);
                if (found) break;
            }
            if (found) break;
        }
    }

    // 3) Third-party services (last resort)
    if (!found) {
        // S2 for hostname and apex domain
        for (const h of [hostname, apexDomain]) {
            if (found) break;
            found = await probeS2(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(h)}`);
        }
    }
    if (!found) {
        for (const h of hostVariants) {
            found = await probeImage(`https://icon.horse/icon/${h}`, PREF_PX)
                 || await probeImage(`https://icon.horse/icon/${h}`, MIN_PX);
            if (found) break;
        }
    }

    // Cache result (empty string for not found)
    sessionFaviconCache.set(hostname, found || '');

    // Persist to DB if found
    if (found) {
        try { await db.favicons.put({ hostname, favicon: found, timestamp: Date.now() }); } catch {}
    }

    return found;
}

// Check DB cache for favicon
async function checkFaviconCache(hostname) {
    try {
        const result = await db.favicons.get(hostname);
        if (result?.favicon && result.timestamp > Date.now() - FAVICON_TTL_MS) {
            return result.favicon;
        }
    } catch {}
    return null;
}

// Run legacy cleanup on load (fire-and-forget)
purgeLegacyFavicons();

// =============================================================================
// END FAVICON MODULE
// =============================================================================

// Mock chrome.storage for development
if (typeof chrome === 'undefined' || !chrome.storage) {
    console.log('Chrome API not available, using mock storage for development');

    // Mock IndexedDB if not available
    if (!window.indexedDB) {
        window.indexedDB = window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    }
}

// Wire popup→dashboard live updates (BroadcastChannel + runtime message)
function wireLiveUpdates() {
    // BroadcastChannel (kept alive via global var)
    try {
      lifetilesBC = new BroadcastChannel('lifetiles');
      lifetilesBC.onmessage = (e) => {
        if (e?.data?.type === 'tiles:changed') {
            __ltScheduleRefresh();
        }
      };
      window.addEventListener('unload', () => { try { lifetilesBC?.close(); } catch {} });
    } catch {}

    // Fallback: runtime message
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'tiles:changed') {
            __ltScheduleRefresh();
        }
      });
    }
  }

/**
 * Ensure unassigned projects exist:
 * - One global unassigned project (dashboardId: null)
 * - One per-dashboard unassigned project for each dashboard
 */
async function ensureUnassignedProjects() {
    // Ensure global unassigned project exists
    const globalUnassigned = await db.projects.get(GLOBAL_UNASSIGNED_ID);
    if (!globalUnassigned) {
        await db.projects.add({
            id: GLOBAL_UNASSIGNED_ID,
            dashboardId: null,
            name: 'Unsorted',
            isUnassigned: true,
            order: -1 // Always first
        });
        console.log('Created global unassigned project');
    }

    // Ensure each dashboard has an unassigned project
    const dashboards = await db.dashboards.toArray();
    for (const dashboard of dashboards) {
        const unassignedId = `${dashboard.id}-unassigned`;
        const existing = await db.projects.get(unassignedId);
        if (!existing) {
            await db.projects.add({
                id: unassignedId,
                dashboardId: dashboard.id,
                name: 'Unsorted',
                isUnassigned: true,
                order: -1 // Always first within dashboard
            });
            console.log(`Created unassigned project for dashboard: ${dashboard.name}`);
        }

        // Clean up duplicate unassigned projects (from import bugs)
        const allProjectsForDashboard = await db.projects.where('dashboardId').equals(dashboard.id).toArray();
        const unassignedProjects = allProjectsForDashboard.filter(p => p.isUnassigned && p.id !== unassignedId);

        if (unassignedProjects.length > 0) {
            console.log(`Found ${unassignedProjects.length} duplicate unassigned project(s) for dashboard: ${dashboard.name}`);

            // Get existing tiles in the correct unassigned project for ordering
            const existingTiles = await db.tiles.where('projectId').equals(unassignedId).toArray();
            let nextOrder = existingTiles.length;

            // Move tiles from duplicate projects and delete them
            for (const dupeProject of unassignedProjects) {
                const dupeTiles = await db.tiles.where('projectId').equals(dupeProject.id).toArray();
                for (const tile of dupeTiles) {
                    await db.tiles.update(tile.id, {
                        projectId: unassignedId,
                        order: nextOrder++
                    });
                }
                await db.projects.delete(dupeProject.id);
                console.log(`Cleaned up duplicate unassigned project: ${dupeProject.id}`);
            }
        }
    }
}

document.addEventListener("DOMContentLoaded", async function () {
    wireLiveUpdates();

    // Add scroll isolation for sidebar
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        // Stop wheel/touch events from bubbling into the page when over the sidebar
        ['wheel', 'touchstart', 'touchmove'].forEach(type => {
            sidebar.addEventListener(type, (e) => {
                e.stopPropagation();
                // NOTE: we do NOT call preventDefault(), so native sidebar scrolling still works.
            }, { passive: true }); // only stopping propagation; passive is fine
        });
    }
    
    // Add scroll isolation for main content area
    const main = document.getElementById('main');
    if (main) {
        // Stop wheel/touch events from bubbling into the page when over the main content
        ['wheel', 'touchstart', 'touchmove'].forEach(type => {
            main.addEventListener(type, (e) => {
                e.stopPropagation(); // keep scroll confined to main content
            }, { passive: true });
        });
    }
    
    // Dexie handles database initialization lazily
    console.log('Database ready (Dexie)');

    // Dashboard Modal Elements
    const dashboardModal = document.getElementById("dashboard-modal");
    const dashboardNameInput = document.getElementById("dashboard-name-input");
    let submitDashboardBtn = document.getElementById("submit-dashboard-name");
    const closeDashboardModal = document.getElementById("close-dashboard-modal");

    // Setup sidebar
    setupSidebar();

    // Setup search
    setupSearch();

    // Project Modal Elements
    const newProjectBtn = document.getElementById("new-project");
    const projectModal = document.getElementById("project-modal");
    const projectNameInput = document.getElementById("project-name-input");
    let submitProjectBtn = document.getElementById("submit-project-name");
    const closeProjectModal = document.getElementById("close-modal");

    // Project Controls
    const projectsList = document.getElementById("projects-list");
    const expandAllBtn = document.getElementById("expand-all");
    const collapseAllBtn = document.getElementById("collapse-all");
    const currentDashboardTitle = document.getElementById("current-dashboard-title");

    // Double-click dashboard title to edit
    if (currentDashboardTitle) {
        currentDashboardTitle.title = 'Double-click to edit';
        currentDashboardTitle.addEventListener('dblclick', () => {
            editDashboardTitleInline();
        });
    }

    // Edit tile name inline using contenteditable
    async function editTileNameInline(nameElement, tileData, tileElement) {
        const currentName = tileData.name;

        // Show full name for editing (not truncated)
        nameElement.textContent = currentName;

        // Make the element editable
        nameElement.contentEditable = 'true';
        nameElement.focus();

        // Select all text
        const range = document.createRange();
        range.selectNodeContents(nameElement);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        let editFinished = false;

        const finishEdit = async (save = false) => {
            if (editFinished) return;
            editFinished = true;

            nameElement.contentEditable = 'false';

            const newName = nameElement.textContent.trim();
            if (save && newName && newName !== currentName) {
                try {
                    await db.tiles.update(tileData.id, { name: newName });
                    tileData.name = newName;
                    nameElement.textContent = truncateText(newName, 60);
                    tileElement.setAttribute("title", newName);
                } catch (err) {
                    console.error('Failed to update tile name:', err);
                    nameElement.textContent = truncateText(currentName, 60);
                }
            } else {
                nameElement.textContent = truncateText(currentName, 60);
            }
        };

        nameElement.addEventListener('blur', () => finishEdit(true), { once: true });
        nameElement.addEventListener('keydown', function handler(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                nameElement.removeEventListener('keydown', handler);
                finishEdit(true);
            } else if (e.key === 'Escape') {
                nameElement.removeEventListener('keydown', handler);
                finishEdit(false);
            }
        });
    }

    // Edit project title inline using contenteditable
    async function editProjectTitleInline(titleElement, projectData) {
        const currentName = titleElement.textContent;

        // Make the element editable
        titleElement.contentEditable = 'true';
        titleElement.focus();

        // Select all text
        const range = document.createRange();
        range.selectNodeContents(titleElement);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        let editFinished = false;

        const finishEdit = async (save = false) => {
            if (editFinished) return;
            editFinished = true;

            titleElement.contentEditable = 'false';

            const newName = titleElement.textContent.trim();
            if (save && newName && newName !== currentName) {
                try {
                    await db.projects.update(projectData.id, { name: newName });
                    titleElement.textContent = newName;
                    projectData.name = newName;
                } catch (err) {
                    console.error('Failed to update project name:', err);
                    titleElement.textContent = currentName;
                }
            } else {
                titleElement.textContent = currentName;
            }
        };

        titleElement.addEventListener('blur', () => finishEdit(true), { once: true });
        titleElement.addEventListener('keydown', function handler(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                titleElement.removeEventListener('keydown', handler);
                finishEdit(true);
            } else if (e.key === 'Escape') {
                titleElement.removeEventListener('keydown', handler);
                finishEdit(false);
            }
        });
    }

    // Edit dashboard title inline using contenteditable
    async function editDashboardTitleInline() {
        // Don't allow editing in Quick Save view
        if (isViewingGlobalUnassigned) return;
        if (!currentDashboardId || !currentDashboardTitle) return;

        const currentName = currentDashboardTitle.textContent;

        // Make the element editable
        currentDashboardTitle.contentEditable = 'true';
        currentDashboardTitle.focus();

        // Select all text
        const range = document.createRange();
        range.selectNodeContents(currentDashboardTitle);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        let editFinished = false;

        const finishEdit = async (save = false) => {
            if (editFinished) return;
            editFinished = true;

            currentDashboardTitle.contentEditable = 'false';

            const newName = currentDashboardTitle.textContent.trim();
            if (save && newName && newName !== currentName) {
                try {
                    await db.dashboards.update(currentDashboardId, { name: newName });
                    currentDashboardTitle.textContent = newName;

                    // Update sidebar
                    const sidebarItem = document.querySelector(`.sidebar-item[data-dashboard-id="${currentDashboardId}"] .label`);
                    if (sidebarItem) sidebarItem.textContent = newName;

                    // Notify popup
                    try {
                        const bc = new BroadcastChannel('lifetiles');
                        bc.postMessage({ type: 'dashboards-changed' });
                        bc.close();
                    } catch (err) { /* ignore */ }

                } catch (err) {
                    console.error('Failed to update dashboard name:', err);
                    currentDashboardTitle.textContent = currentName; // Restore on error
                }
            } else {
                currentDashboardTitle.textContent = currentName; // Restore if cancelled or unchanged
            }
        };

        currentDashboardTitle.addEventListener('blur', () => finishEdit(true), { once: true });
        currentDashboardTitle.addEventListener('keydown', function handler(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                currentDashboardTitle.removeEventListener('keydown', handler);
                finishEdit(true);
            } else if (e.key === 'Escape') {
                currentDashboardTitle.removeEventListener('keydown', handler);
                finishEdit(false);
            }
        });
    }

    // Tile Modal Elements
    const tileModal = document.getElementById("tile-modal");
    const tileNameInput = document.getElementById("tile-name-input");
    const tileUrlInput = document.getElementById("tile-url-input");
    let submitTileBtn = document.getElementById("submit-tile");
    const closeTileModal = document.getElementById("close-tile-modal");

    // Popup Save Modal Elements
    const popupSaveModal = document.getElementById("popup-save-modal");
    const popupTileNameInput = document.getElementById("popup-tile-name-input");
    const popupTileUrlInput = document.getElementById("popup-tile-url-input");
    const submitPopupTileBtn = document.getElementById("submit-popup-tile");
    const closePopupModal = document.getElementById("close-popup-modal");
    
    // Settings gear with dropdown menu
    const settingsBtn = document.getElementById('open-settings');
    if (settingsBtn) {
        // Create the settings menu
        const menu = document.createElement('div');
        menu.className = 'settings-menu';
        menu.innerHTML = `
            <button type="button" data-action="import-google">Import Google bookmarks</button>
            <button type="button" data-action="export-dashboards"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Backup</button>
            <button type="button" data-action="import-dashboards"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Restore</button>
        `;
        settingsBtn.parentElement.appendChild(menu);

        // Toggle open/close
        function closeSettingsMenu() {
            settingsBtn.classList.remove('active');
            settingsBtn.setAttribute('aria-expanded', 'false');
        }
        function openSettingsMenu() {
            settingsBtn.classList.add('active');
            settingsBtn.setAttribute('aria-expanded', 'true');
        }

        settingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (settingsBtn.classList.contains('active')) closeSettingsMenu(); else openSettingsMenu();
        });

        // Click outside & ESC to close
        document.addEventListener('click', (e) => {
            if (!menu.contains(e.target) && e.target !== settingsBtn) closeSettingsMenu();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeSettingsMenu();
        });

        // Hook up actions
        menu.addEventListener('click', async (e) => {
            if (!(e.target instanceof HTMLElement)) return;
            const action = e.target.dataset.action;
            if (!action) return;

            try {
                if (action === 'import-google') {
                    await importGoogleBookmarks();
                } else if (action === 'export-dashboards') {
                    await exportDashboardsJSON();
                } else if (action === 'import-dashboards') {
                    await importDashboardsJSON();
                }
            } catch (err) {
                console.error(err);
                alert('Something went wrong. Check the console for details.');
            } finally {
                closeSettingsMenu();
            }
        });
    }


    let currentProjectContainer = null;
    let currentProjectId = null;
    let currentDashboardId = null;
    let isViewingGlobalUnassigned = false; // Track if viewing global unassigned view
    let draggedProjectId = null; // Track project being dragged to sidebar
    let draggedTileId = null; // Track tile being dragged (for sidebar drops)
    let draggedTileElement = null; // Track tile element being dragged
    let tileDroppedOnSidebar = false; // Flag when tile dropped on sidebar

    // Helper: Get the next available order for a new project in a dashboard
    async function getNextProjectOrder(dashboardId) {
        const existingProjects = await db.projects.where('dashboardId').equals(dashboardId).toArray();

        // Calculate max order + 1
        let maxOrder = -1;
        existingProjects.forEach(p => {
            const order = Number.isFinite(+p.order) ? +p.order : -1;
            if (order > maxOrder) maxOrder = order;
        });
        return maxOrder + 1;
    }

    // Move a project to a different dashboard
    async function moveProjectToDashboard(projectId, newDashboardId) {
        if (!projectId || !newDashboardId) return;

        const normalizedNewId = String(newDashboardId);
        if (normalizedNewId === String(currentDashboardId)) return; // Already on this dashboard

        // Get existing projects in target dashboard to calculate order
        let existingProjects = await db.projects.where('dashboardId').equals(normalizedNewId).toArray();

        // Try number version if no results (handle legacy type mismatches)
        if (existingProjects.length === 0 && !isNaN(normalizedNewId)) {
            existingProjects = await db.projects.where('dashboardId').equals(Number(normalizedNewId)).toArray();
        }

        // Calculate the new order (max + 1, or 0 if no projects)
        const maxOrder = existingProjects.reduce((max, p) => {
            const order = Number.isFinite(+p.order) ? +p.order : -1;
            return order > max ? order : max;
        }, -1);
        const newOrder = maxOrder + 1;

        // Determine the correct type to store
        const dashboardIdToStore = existingProjects.length > 0
            ? existingProjects[0].dashboardId
            : (typeof currentDashboardId === 'number' ? Number(normalizedNewId) : normalizedNewId);

        // Update project
        const project = await db.projects.get(projectId);
        if (project) {
            project.dashboardId = dashboardIdToStore;
            project.order = newOrder;
            await db.projects.put(project);

            // Update all tiles in this project
            await db.tiles.where('projectId').equals(projectId).modify({ dashboardId: dashboardIdToStore });
        }

        // Note: We don't reload here - the DOM element is already removed by the caller
    }

    // Load dashboards and projects on startup
    loadDashboards().catch(error => {
        console.error('Error loading dashboards:', error);
    });

    // First-run check
    if (!localStorage.getItem('linktiles_first_run_complete')) {
        const welcomeModal = document.getElementById('welcome-modal');
        if (welcomeModal) {
            welcomeModal.style.display = 'flex';

            document.getElementById('welcome-start-fresh').onclick = () => {
                localStorage.setItem('linktiles_first_run_complete', 'true');
                welcomeModal.style.display = 'none';
            };

            document.getElementById('welcome-import').onclick = async () => {
                localStorage.setItem('linktiles_first_run_complete', 'true');
                welcomeModal.style.display = 'none';
                if (chrome?.bookmarks) {
                    await importGoogleBookmarks();
                } else {
                    await importDashboardsJSON();
                }
            };
        }
    }

// Track last known mouse position during drag
let lastDragMouseX = 0;
let lastDragMouseY = 0;

function handleDragMouseMove(e) {
    lastDragMouseX = e.clientX;
    lastDragMouseY = e.clientY;

    // Highlight sidebar item if mouse is over it
    document.querySelectorAll('.sidebar-item').forEach(item => {
        // Skip highlighting current space and Quick Save when dragging projects
        if (draggedProjectId) {
            if (item.dataset.dashboardId === currentDashboardId) {
                item.classList.remove('drag-hover');
                return;
            }
            if (item.classList.contains('sidebar-item-unassigned')) {
                item.classList.remove('drag-hover');
                return;
            }
        }
        const rect = item.getBoundingClientRect();
        const isOver = lastDragMouseX >= rect.left && lastDragMouseX <= rect.right &&
                       lastDragMouseY >= rect.top && lastDragMouseY <= rect.bottom;
        item.classList.toggle('drag-hover', isOver);
    });
}

// Initialize project sorting
new Sortable(document.getElementById('projects-list'), {
    animation: 150,
    draggable: '.project',
    handle: '.project-drag-handle',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    forceFallback: true,  // Use fallback for better cross-container dragging
    fallbackOnBody: true, // Append ghost to body so it can move outside container
    fallbackTolerance: 3,
    onStart: function (evt) {
      document.body.classList.add('dragging', 'dragging-project');
      document.body.style.cursor = 'grabbing';
      draggedProjectId = evt.item.dataset.projectId;

      // Track mouse movement during drag
      document.addEventListener('mousemove', handleDragMouseMove);
    },
    onEnd: function (evt) {
      document.body.classList.remove('dragging', 'dragging-project');
      document.body.style.cursor = '';

      // Stop tracking mouse movement
      document.removeEventListener('mousemove', handleDragMouseMove);

      // Check if dropped over a sidebar item using last known mouse position
      // Skip Quick Save (sidebar-item-unassigned) - projects can't be dropped there
      let droppedOnDashboard = null;

      document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('drag-hover');
        // Skip Quick Save item - projects can only be moved to dashboards
        if (item.classList.contains('sidebar-item-unassigned')) return;
        const rect = item.getBoundingClientRect();
        if (lastDragMouseX >= rect.left && lastDragMouseX <= rect.right &&
            lastDragMouseY >= rect.top && lastDragMouseY <= rect.bottom) {
          droppedOnDashboard = item.dataset.dashboardId;
        }
      });

      if (droppedOnDashboard && draggedProjectId && droppedOnDashboard !== currentDashboardId) {
        // Move project to new dashboard (skip if same as current)
        // Remove the project element from DOM immediately
        const projectEl = document.querySelector(`.project[data-project-id="${draggedProjectId}"]`);
        if (projectEl) {
          projectEl.remove();
        }
        moveProjectToDashboard(draggedProjectId, droppedOnDashboard);
      } else {
        // Normal reorder within same dashboard
        updateProjectOrder(evt);
      }

      draggedProjectId = null;
    }
  });


    // Project Modal Event Listeners
    newProjectBtn.addEventListener("click", function() {
        projectModal.style.display = "flex";
        projectNameInput.focus();
    });

    projectNameInput.addEventListener("input", validateProjectInput);

    projectNameInput.addEventListener("keydown", function(event) {
        if (event.key === 'Enter' && !submitProjectBtn.disabled) {
            submitProjectBtn.click();
        }
    });

    submitProjectBtn.addEventListener("click", createNewProject);
    closeProjectModal.addEventListener("click", closeProjectModalHandler);

    // Expand/Collapse All Event Listeners
    expandAllBtn.addEventListener('click', async () => {
        const projects = projectsList.querySelectorAll('.project.collapsed');
        for (const proj of projects) {
            proj.classList.remove('collapsed');
            await db.projects.update(proj.dataset.projectId, { collapsed: false });
        }
    });

    collapseAllBtn.addEventListener('click', async () => {
        const projects = projectsList.querySelectorAll('.project:not(.collapsed)');
        for (const proj of projects) {
            proj.classList.add('collapsed');
            await db.projects.update(proj.dataset.projectId, { collapsed: true });
        }
    });

    // Tile Modal Event Listeners
    tileNameInput.addEventListener("input", validateTileInputs);
    tileUrlInput.addEventListener("input", validateTileInputs);

    tileNameInput.addEventListener("keydown", function(event) {
        if (event.key === 'Enter' && !submitTileBtn.disabled) {
            submitTileBtn.click();
        }
    });

    submitTileBtn.addEventListener("click", createNewTile);
    closeTileModal.addEventListener("click", closeTileModalHandler);

    // Popup Save Modal Event Listeners
    popupTileNameInput.addEventListener("input", validatePopupTileInputs);

    popupTileNameInput.addEventListener("keydown", function(event) {
        if (event.key === 'Enter' && !submitPopupTileBtn.disabled) {
            submitPopupTileBtn.click();
        }
    });

    submitPopupTileBtn.addEventListener("click", createNewTileFromPopup);
    closePopupModal.addEventListener("click", closePopupModalHandler);


    // Validation Functions
    function validateProjectInput() {
        const isValid = projectNameInput.value.trim() !== "";
        submitProjectBtn.disabled = !isValid;
        submitProjectBtn.classList.toggle("enabled", isValid);
    }

    function validateTileInputs() {
        const nameValid = tileNameInput.value.trim() !== "";
        const urlValid = (() => {
            try {
              const u = new URL(tileUrlInput.value);
              return (u.protocol === 'http:' || u.protocol === 'https:');
            } catch { return false; }
          })();

        const isValid = nameValid && urlValid;

        submitTileBtn.disabled = !isValid;
        submitTileBtn.classList.toggle("enabled", isValid);
    }

    function validatePopupTileInputs() {
        const nameValid = popupTileNameInput.value.trim() !== "";
        const urlValid = (() => {
            try {
              const u = new URL(popupTileUrlInput.value);
              return (u.protocol === 'http:' || u.protocol === 'https:');
            } catch { return false; }
          })();

        const isValid = nameValid && urlValid;

        submitPopupTileBtn.disabled = !isValid;
        submitPopupTileBtn.classList.toggle("enabled", isValid);
    }

    function isValidUrl(string) {
        try {
            const url = new URL(string);
            // Only allow http and https schemes to prevent javascript:/data: execution
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    // Modal Handlers
    function closeProjectModalHandler() {
        projectModal.style.display = "none";
        projectNameInput.value = "";
        validateProjectInput();
        projectModal.querySelector('h2').textContent = "Create New Project";
    }

    function closeTileModalHandler() {
        tileModal.style.display = "none";
        tileModal.querySelector('h2').textContent = "Create New Tile";
        tileNameInput.value = "";
        tileUrlInput.value = "";
        validateTileInputs();
        currentProjectContainer = null;
        currentProjectId = null;
    }

    function closePopupModalHandler() {
        popupSaveModal.style.display = "none";
        popupTileNameInput.value = "";
        popupTileUrlInput.value = "";
        validatePopupTileInputs();
    }

    // Storage functions
    async function loadDashboards() {
        try {
            // Ensure unassigned projects exist (global + per-dashboard)
            await ensureUnassignedProjects();

            // Get all dashboards
            let dashboards = await db.dashboards.toArray();

            // Sort dashboards by order property
            if (dashboards && dashboards.length > 0) {
                const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
                dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));
            }

            if (!dashboards || dashboards.length === 0) {
                // Create a default dashboard
                const defaultDashboard = {
                    id: (crypto?.randomUUID?.() || Date.now().toString()),
                    name: "Personal",
                    order: 0
                };

                await db.dashboards.add(defaultDashboard);

                // Select it
                localStorage.setItem('currentDashboardId', defaultDashboard.id);
                currentDashboardId = defaultDashboard.id;

                // Paint the UI immediately
                renderSidebar([defaultDashboard], defaultDashboard.id);
                if (currentDashboardTitle) currentDashboardTitle.textContent = defaultDashboard.name;
                projectsList.innerHTML = '';

                return [defaultDashboard];
            }

            const currentId = localStorage.getItem('currentDashboardId') || dashboards[0].id;

            // Validate that the current dashboard still exists
            const validCurrentId = dashboards.find(d => d.id === currentId) ? currentId : dashboards[0].id;
            if (validCurrentId !== currentId) {
                localStorage.setItem('currentDashboardId', validCurrentId);
                currentDashboardId = validCurrentId;
            }

            // Check if user was viewing Quick Save before refresh
            const wasViewingQuickSave = localStorage.getItem('isViewingGlobalUnassigned') === 'true';

            // Hide UI elements immediately if restoring Quick Save view (prevents flash)
            if (wasViewingQuickSave) {
                const newProjectBtn = document.getElementById('new-project');
                const expandAllBtn = document.getElementById('expand-all');
                const collapseAllBtn = document.getElementById('collapse-all');
                if (newProjectBtn) newProjectBtn.style.display = 'none';
                if (expandAllBtn) expandAllBtn.style.display = 'none';
                if (collapseAllBtn) collapseAllBtn.style.display = 'none';
                document.body.classList.add('quick-save-view');
            }

            renderSidebar(dashboards, wasViewingQuickSave ? GLOBAL_UNASSIGNED_ID : validCurrentId);

            // If was viewing Quick Save, restore that view
            if (wasViewingQuickSave) {
                await switchToGlobalUnassigned();
                return dashboards;
            }

            // Update dashboard title
            const currentDash = dashboards.find(d => d.id === validCurrentId);
            if (currentDashboardTitle) currentDashboardTitle.textContent = currentDash ? currentDash.name : '';

            // Clear existing projects before loading new ones
            projectsList.innerHTML = '';

            // Load projects for current dashboard
            const allProjects = await db.projects.where('dashboardId').equals(validCurrentId).toArray();

            // Separate unassigned project from regular projects
            const unassignedProject = allProjects.find(p => p.isUnassigned);
            const regularProjects = allProjects.filter(p => !p.isUnassigned);

            // Load tiles for unassigned project
            if (unassignedProject) {
                unassignedProject.tiles = await db.tiles.where('projectId').equals(unassignedProject.id).toArray();
            }

            // Load all tiles for regular projects
            for (const project of regularProjects) {
                project.tiles = await db.tiles.where('projectId').equals(project.id).toArray();
            }

            // Render unassigned section above projects
            await renderUnassignedSection(unassignedProject);

            // Render regular projects
            await loadProjects(regularProjects);
            currentDashboardId = validCurrentId;

            return dashboards;
        } catch (error) {
            console.error('Error in loadDashboards:', error);
            return [];
        }
    }
// make the dashboard reload callable from outside this closure
// Preserve the current view state (Quick Save vs dashboard) when refreshing
window.__lifetilesRefresh = async () => {
    if (isViewingGlobalUnassigned) {
        // Refresh Quick Save view without switching views
        // Clear first to prevent duplicates
        projectsList.innerHTML = '';
        await loadGlobalUnassignedView();
        await updateQuickSaveCount();
    } else {
        await loadDashboards();
    }
};

// Create sidebar item element
    function createSidebarItem(dashboard) {
        const li = document.createElement('li');
        li.className = 'sidebar-item';
        li.setAttribute('role', 'option');
        li.dataset.dashboardId = dashboard.id;
        li.innerHTML = `
            <span class="dot"></span>
            <span class="label">${escapeHtml(dashboard.name)}</span>
            <div class="actions">
                <button class="sidebar-item-btn delete-btn" title="Delete" aria-label="Delete space"></button>
            </div>
        `;
        return li;
    }

    // Render sidebar with all dashboards
    async function renderSidebar(dashboards, currentId) {
        const list = document.getElementById('sidebar-list');
        if (!list) return;

        list.innerHTML = '';

        // Add global unassigned entry at the top
        const globalUnassignedLi = document.createElement('li');
        globalUnassignedLi.className = 'sidebar-item sidebar-item-unassigned';
        globalUnassignedLi.setAttribute('role', 'option');
        globalUnassignedLi.dataset.dashboardId = GLOBAL_UNASSIGNED_ID;

        // Get count of global unassigned tiles
        const globalUnassignedTiles = await db.tiles.where('projectId').equals(GLOBAL_UNASSIGNED_ID).toArray();
        const tileCount = globalUnassignedTiles.length;

        globalUnassignedLi.innerHTML = `
            <span class="unassigned-icon">📌</span>
            <span class="label">Quick Save${tileCount > 0 ? ` (${tileCount})` : ''}</span>
        `;

        // Set selected state
        globalUnassignedLi.setAttribute('aria-selected', String(isViewingGlobalUnassigned));
        globalUnassignedLi.tabIndex = isViewingGlobalUnassigned ? 0 : -1;

        // Click to view global unassigned
        globalUnassignedLi.addEventListener('click', () => {
            switchToGlobalUnassigned();
        });

        // Make it a drop target for tiles only (not projects)
        globalUnassignedLi.addEventListener('dragover', (e) => {
            // Only allow tile drops, not project drops
            if (!draggedTileId || draggedProjectId) return;
            e.preventDefault();
            globalUnassignedLi.classList.add('drag-hover');
        });

        globalUnassignedLi.addEventListener('dragleave', (e) => {
            if (!globalUnassignedLi.contains(e.relatedTarget)) {
                globalUnassignedLi.classList.remove('drag-hover');
            }
        });

        globalUnassignedLi.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            globalUnassignedLi.classList.remove('drag-hover');

            if (draggedTileId) {
                // Set flag SYNCHRONOUSLY so Sortable's onEnd knows to skip processing
                tileDroppedOnSidebar = true;

                // Capture the ID before any async operations
                const tileId = draggedTileId;

                // Remove the tile from DOM immediately (sync)
                const tileEl = document.querySelector(`.tile[data-tile-id="${tileId}"]`);
                if (tileEl) tileEl.remove();

                // Do DB operations async
                (async () => {
                    // Move tile to global unassigned in DB
                    await db.tiles.update(tileId, { projectId: GLOBAL_UNASSIGNED_ID });

                    // Update the count in sidebar
                    await updateQuickSaveCount();

                    // Update source container's empty state
                    updateUnassignedEmptyState();
                })();
            }
        });

        list.appendChild(globalUnassignedLi);

        // Add separator
        const separator = document.createElement('li');
        separator.className = 'sidebar-separator';
        separator.setAttribute('role', 'separator');
        list.appendChild(separator);

        // Add Spaces heading with + button
        const dashboardsHeader = document.createElement('li');
        dashboardsHeader.className = 'sidebar-section-header';
        dashboardsHeader.innerHTML = `
            <span class="section-title">Spaces</span>
            <button class="section-add-btn" title="New space" aria-label="Add new space">+</button>
        `;
        dashboardsHeader.querySelector('.section-add-btn').addEventListener('click', () => {
            const modal = document.getElementById('dashboard-modal');
            const input = document.getElementById('dashboard-name-input');
            modal.style.display = 'flex';
            if (input) {
                input.value = '';
                input.focus();
            }
        });
        list.appendChild(dashboardsHeader);

        // Sort dashboards by order
        const sortedDashboards = dashboards.slice().sort((a, b) => {
            const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
            const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
            return ao - bo || String(a.id).localeCompare(String(b.id));
        });

        sortedDashboards.forEach(dashboard => {
            const li = createSidebarItem(dashboard);
            // Only select dashboard if not viewing global unassigned
            const isSelected = !isViewingGlobalUnassigned && dashboard.id === currentId;
            li.setAttribute('aria-selected', String(isSelected));
            li.tabIndex = isSelected ? 0 : -1;

            // Click to select dashboard
            li.addEventListener('click', (e) => {
                if (e.target.closest('.actions')) return; // Don't select if clicking action buttons
                switchDashboard(dashboard.id);
            });

            // Double-click label to edit (only if already selected)
            const labelEl = li.querySelector('.label');
            labelEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (dashboard.id === currentDashboardId) {
                    editDashboardInline(dashboard, li);
                }
            });

            // Delete button
            const deleteBtn = li.querySelector('.delete-btn');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteDashboardFromSidebar(dashboard.id);
            });

            // Make dashboard a drop target for tiles (goes to dashboard's unassigned)
            li.addEventListener('dragover', (e) => {
                e.preventDefault();
                li.classList.add('drag-hover');
            });

            li.addEventListener('dragleave', (e) => {
                if (!li.contains(e.relatedTarget)) {
                    li.classList.remove('drag-hover');
                }
            });

            li.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                li.classList.remove('drag-hover');

                if (draggedTileId) {
                    // Get the dashboard's unassigned project ID
                    const unassignedProjectId = `${dashboard.id}-unassigned`;

                    // Set flag SYNCHRONOUSLY so Sortable's onEnd knows to skip processing
                    tileDroppedOnSidebar = true;

                    // Capture the ID before any async operations
                    const tileId = draggedTileId;

                    // Remove the tile from DOM immediately (sync)
                    const tileEl = document.querySelector(`.tile[data-tile-id="${tileId}"]`);
                    if (tileEl) tileEl.remove();

                    // Do DB operations async
                    (async () => {
                        // Move tile to dashboard's unassigned in DB
                        await db.tiles.update(tileId, { projectId: unassignedProjectId });

                        // Update source container's empty state
                        updateUnassignedEmptyState();

                        // Update Quick Save count (tile was moved out of Quick Save)
                        await updateQuickSaveCount();

                        // If we're currently viewing this dashboard, refresh to show the tile
                        if (dashboard.id === currentDashboardId && !isViewingGlobalUnassigned) {
                            await loadProjectsForDashboard(dashboard.id);
                        }
                    })();
                }
            });

            list.appendChild(li);
        });

        // Optional: Make sidebar sortable for reordering (exclude unassigned and separator)
        if (window.Sortable && !list.__sortable) {
            list.__sortable = new Sortable(list, {
                animation: 150,
                filter: '.sidebar-item-unassigned, .sidebar-separator, .sidebar-section-header',
                onEnd: async () => {
                    const ids = [...list.querySelectorAll('.sidebar-item:not(.sidebar-item-unassigned)')]
                        .map(li => li.dataset.dashboardId)
                        .filter(id => id && id !== GLOBAL_UNASSIGNED_ID);
                    await updateDashboardOrderFromSidebar(ids);
                }
            });
        }
    }

    // Edit dashboard name inline
    async function editDashboardInline(dashboard, listItem) {
        const labelEl = listItem.querySelector('.label');
        const actionsEl = listItem.querySelector('.actions');

        // Create input
        const input = document.createElement('input');
        input.type = 'text';
        input.value = dashboard.name;
        input.style.cssText = 'border:1px solid #ddd; border-radius:4px; padding:4px 6px; font-size:14px; flex:1; min-width:0; box-sizing:border-box; margin:0; line-height:1.2; align-self:center;';

        // Replace label with input
        labelEl.style.display = 'none';
        actionsEl.style.display = 'none';
        listItem.insertBefore(input, actionsEl);
        input.focus();
        input.select();

        let editFinished = false; // Guard against double-call from blur after Enter/Escape

        const finishEdit = async (save = false) => {
            if (editFinished) return; // Prevent double-call
            editFinished = true;

            const newName = input.value.trim();
            if (save && newName && newName !== dashboard.name) {
                try {
                    await db.dashboards.update(dashboard.id, { name: newName });
                    labelEl.textContent = newName;
                    dashboard.name = newName;

                    // Update dashboard title if this is the current dashboard
                    if (dashboard.id === currentDashboardId && currentDashboardTitle) {
                        currentDashboardTitle.textContent = newName;
                    }

                    // Notify popup of dashboard change
                    try {
                        const bc = new BroadcastChannel('lifetiles');
                        bc.postMessage({ type: 'dashboards:changed' });
                        bc.close();
                    } catch {}
                } catch (error) {
                    console.error('Error updating dashboard name:', error);
                }
            }

            input.remove();
            labelEl.style.display = '';
            actionsEl.style.display = '';
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') finishEdit(true);
            if (e.key === 'Escape') finishEdit(false);
        });

        input.addEventListener('blur', () => finishEdit(true));
    }

    // Delete dashboard from sidebar
    async function deleteDashboardFromSidebar(dashboardId) {
        await deleteDashboardFromManage(dashboardId, null);
    }

    // Update dashboard order from sidebar
    async function updateDashboardOrderFromSidebar(idsInNewOrder) {
        try {
            for (let idx = 0; idx < idsInNewOrder.length; idx++) {
                await db.dashboards.update(idsInNewOrder[idx], { order: idx });
            }
        } catch (error) {
            console.error('Error updating dashboard order:', error);
        }
    }

    // Setup sidebar functionality
    function setupSidebar() {
        const addBtn = document.getElementById('sidebar-add');
        addBtn?.addEventListener('click', async () => {
            dashboardModal.style.display = "flex";
            dashboardNameInput.value = "";
            dashboardNameInput.focus();
        });
    }

    // Setup search functionality
    function setupSearch() {
        const searchInput = document.getElementById('sidebar-search');
        const searchResults = document.getElementById('search-results');
        if (!searchInput || !searchResults) return;

        let searchTimeout;
        let dashboardsCache = [];

        // Cache dashboards for name lookup
        async function cacheDashboards() {
            dashboardsCache = await db.dashboards.toArray();
            return dashboardsCache;
        }

        function getDashboardName(dashboardId) {
            const d = dashboardsCache.find(db => String(db.id) === String(dashboardId));
            return d?.name || 'Unknown';
        }

        async function searchAll(query) {
            if (!query || query.length < 2) return { dashboards: [], projects: [], tiles: [] };

            const q = query.toLowerCase();
            const [allDashboards, allProjects, allTiles] = await Promise.all([
                db.dashboards.toArray(),
                db.projects.toArray(),
                db.tiles.toArray()
            ]);

            const dashboards = allDashboards.filter(d => d.name.toLowerCase().includes(q));
            const projects = allProjects.filter(p => p.name.toLowerCase().includes(q));
            const tiles = allTiles.filter(t => t.name.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));

            return { dashboards, projects, tiles };
        }

        function renderSearchResults(results) {
            const { dashboards, projects, tiles } = results;

            if (!dashboards.length && !projects.length && !tiles.length) {
                searchResults.innerHTML = '<div class="search-result-item" style="color: var(--color-text-muted);">No results found</div>';
                searchResults.classList.remove('hidden');
                return;
            }

            let html = '';

            if (dashboards.length) {
                html += '<div class="search-result-group">Spaces</div>';
                dashboards.forEach(d => {
                    html += `<div class="search-result-item" data-type="dashboard" data-id="${d.id}">${escapeHtml(d.name)}</div>`;
                });
            }

            if (projects.length) {
                html += '<div class="search-result-group">Projects</div>';
                projects.forEach(p => {
                    html += `<div class="search-result-item" data-type="project" data-id="${p.id}" data-dashboard-id="${p.dashboardId}">
                        ${escapeHtml(p.name)}
                        <span class="result-context">in ${escapeHtml(getDashboardName(p.dashboardId))}</span>
                    </div>`;
                });
            }

            if (tiles.length) {
                html += '<div class="search-result-group">Tiles</div>';
                tiles.forEach(t => {
                    let hostname = '';
                    try { hostname = new URL(t.url).hostname; } catch {}
                    html += `<div class="search-result-item" data-type="tile" data-id="${t.id}" data-dashboard-id="${t.dashboardId}" data-project-id="${t.projectId}">
                        ${escapeHtml(t.name)}
                        <span class="result-context">${escapeHtml(hostname)}</span>
                    </div>`;
                });
            }

            searchResults.innerHTML = html;
            searchResults.classList.remove('hidden');
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text || '';
            return div.innerHTML;
        }

        function highlightElement(el) {
            el.classList.add('search-highlight');
            setTimeout(() => el.classList.remove('search-highlight'), 2000);
        }

        // Debounced input handler
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(async () => {
                const query = searchInput.value.trim();
                if (query.length < 2) {
                    searchResults.classList.add('hidden');
                    return;
                }
                await cacheDashboards();
                const results = await searchAll(query);
                renderSearchResults(results);
            }, 200);
        });

        // Handle result clicks
        searchResults.addEventListener('click', async (e) => {
            const item = e.target.closest('.search-result-item');
            if (!item || !item.dataset.type) return;

            const { type, id, dashboardId, projectId } = item.dataset;

            // Clear search
            searchInput.value = '';
            searchResults.classList.add('hidden');

            if (type === 'dashboard') {
                await switchDashboard(id);
            } else if (type === 'project') {
                await switchDashboard(dashboardId);
                // Wait for DOM to fully render, then scroll to project
                setTimeout(() => {
                    const projectEl = document.querySelector(`.project[data-project-id="${id}"]`);
                    if (projectEl) {
                        projectEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlightElement(projectEl);
                    }
                }, 100);
            } else if (type === 'tile') {
                await switchDashboard(dashboardId);
                setTimeout(() => {
                    const tileEl = document.querySelector(`.tile[data-tile-id="${id}"]`);
                    if (tileEl) {
                        tileEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlightElement(tileEl);
                    }
                }, 100);
            }
        });

        // Close results on click outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.toolbar-search-container')) {
                searchResults.classList.add('hidden');
            }
        });

        // Close on Escape key
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchInput.value = '';
                searchResults.classList.add('hidden');
                searchInput.blur();
            }
        });
    }

    async function switchDashboard(dashboardId) {
        // Skip if already on this dashboard and not viewing global unassigned
        if (dashboardId === currentDashboardId && !isViewingGlobalUnassigned) return;

        // Exit bulk mode if active
        if (typeof window.__exitBulkMode === 'function') {
            window.__exitBulkMode();
        }

        // Exit global unassigned view
        isViewingGlobalUnassigned = false;
        localStorage.removeItem('isViewingGlobalUnassigned');
        document.body.classList.remove('quick-save-view');

        // Show project controls (hidden in global unassigned view)
        const newProjectBtn = document.getElementById('new-project');
        if (newProjectBtn) newProjectBtn.style.display = '';

        // Show all control buttons (some hidden in Quick Save view)
        const expandAllBtn = document.getElementById('expand-all');
        const collapseAllBtn = document.getElementById('collapse-all');
        const bulkSelectBtn = document.getElementById('bulk-select');
        if (expandAllBtn) expandAllBtn.style.display = '';
        if (collapseAllBtn) collapseAllBtn.style.display = '';
        if (bulkSelectBtn) bulkSelectBtn.style.display = '';

        // Restore title editable behavior
        if (currentDashboardTitle) {
            currentDashboardTitle.title = 'Double-click to edit';
            currentDashboardTitle.style.cursor = '';
        }

        // Update active sidebar item and get dashboard name
        let dashboardName = '';
        document.querySelectorAll('.sidebar-item').forEach(item => {
            const isActive = item.dataset.dashboardId === dashboardId;
            item.setAttribute('aria-selected', String(isActive));
            item.tabIndex = isActive ? 0 : -1;
            if (isActive && !item.classList.contains('sidebar-item-unassigned')) {
                const nameSpan = item.querySelector('.label');
                dashboardName = nameSpan ? nameSpan.textContent : '';
            }
        });

        // Update dashboard title in project controls
        if (currentDashboardTitle) currentDashboardTitle.textContent = dashboardName;

        // Save current dashboard
        localStorage.setItem('currentDashboardId', dashboardId);
        currentDashboardId = dashboardId;

        // Clear projects list
        projectsList.innerHTML = '';

        // Load projects for selected dashboard
        await loadProjectsForDashboard(dashboardId);
    }

    /**
     * Switch to viewing global unassigned tiles
     */
    async function switchToGlobalUnassigned() {
        // Skip if already viewing
        if (isViewingGlobalUnassigned) return;

        // Exit bulk mode if active
        if (typeof window.__exitBulkMode === 'function') {
            window.__exitBulkMode();
        }

        isViewingGlobalUnassigned = true;
        localStorage.setItem('isViewingGlobalUnassigned', 'true');
        document.body.classList.add('quick-save-view');

        // Update active sidebar item
        document.querySelectorAll('.sidebar-item').forEach(item => {
            const isUnassigned = item.classList.contains('sidebar-item-unassigned');
            item.setAttribute('aria-selected', String(isUnassigned));
            item.tabIndex = isUnassigned ? 0 : -1;
        });

        // Update dashboard title (non-editable for Quick Save)
        if (currentDashboardTitle) {
            currentDashboardTitle.textContent = 'Quick Save';
            currentDashboardTitle.title = ''; // Remove "Double-click to edit" tooltip
            currentDashboardTitle.style.cursor = 'default';
        }

        // Hide new project button
        const newProjectBtn = document.getElementById('new-project');
        if (newProjectBtn) newProjectBtn.style.display = 'none';

        // Show only the Select button, hide Expand/Collapse
        const expandAllBtn = document.getElementById('expand-all');
        const collapseAllBtn = document.getElementById('collapse-all');
        const bulkSelectBtn = document.getElementById('bulk-select');
        if (expandAllBtn) expandAllBtn.style.display = 'none';
        if (collapseAllBtn) collapseAllBtn.style.display = 'none';
        if (bulkSelectBtn) bulkSelectBtn.style.display = '';

        // Clear projects list
        projectsList.innerHTML = '';

        // Load and display global unassigned tiles
        await loadGlobalUnassignedView();
    }

    /**
     * Load and display the global unassigned tiles view (flat grid, no projects)
     */
    async function loadGlobalUnassignedView() {
        const tiles = await db.tiles.where('projectId').equals(GLOBAL_UNASSIGNED_ID).toArray();

        // Sort tiles by order
        tiles.sort((a, b) => {
            const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
            const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
            return ao - bo || String(a.id).localeCompare(String(b.id));
        });

        // Create container for global unassigned view
        const container = document.createElement('div');
        container.className = 'global-unassigned-view';

        if (tiles.length === 0) {
            // Empty state
            container.innerHTML = `
                <div class="global-unassigned-empty">
                    <p>No unassigned tiles</p>
                    <p class="hint">Save tiles from the browser extension without assigning them to a project, and they'll appear here.</p>
                </div>
            `;
        } else {
            // Tiles grid
            container.innerHTML = `<div class="tiles-grid global-unassigned-tiles"></div>`;
            const tilesGrid = container.querySelector('.global-unassigned-tiles');

            for (const tile of tiles) {
                await createTileElement(tilesGrid, tile);
            }

            // Make tiles sortable
            if (window.Sortable) {
                new Sortable(tilesGrid, {
                    group: 'tiles',
                    animation: 150,
                    draggable: '.tile',
                    ghostClass: 'sortable-ghost',
                    chosenClass: 'sortable-chosen',
                    dragClass: 'sortable-drag',
                    onStart: function(evt) {
                        document.body.classList.add('dragging', 'dragging-tile');
                        draggedTileId = evt.item.dataset.tileId;
                        draggedTileElement = evt.item;
                    },
                    onEnd: async function(evt) {
                        // If tile was dropped on sidebar, skip processing
                        if (tileDroppedOnSidebar) {
                            document.body.classList.remove('dragging', 'dragging-tile');
                            document.querySelectorAll('.unassigned-section').forEach(s => s.classList.remove('drag-nearby'));
                            tileDroppedOnSidebar = false;
                            draggedTileId = null;
                            draggedTileElement = null;
                            return;
                        }

                        // Move add-tile buttons to end in both containers
                        requestAnimationFrame(() => {
                            [evt.from, evt.to].forEach(container => {
                                const btn = container?.querySelector('.add-tile-button');
                                if (btn) container.appendChild(btn);
                            });
                        });

                        // Resequence remaining tiles in Quick Save only
                        const tileEls = [...evt.from.querySelectorAll('.tile[data-tile-id]')];
                        await Promise.all(tileEls.map((el, idx) =>
                            db.tiles.update(el.dataset.tileId, {
                                projectId: GLOBAL_UNASSIGNED_ID,
                                order: idx
                            })
                        ));

                        // If tile was moved to a different container (e.g., a project),
                        // update Quick Save count. The destination's Sortable handles the projectId update.
                        if (evt.to !== evt.from) {
                            await updateQuickSaveCount();
                        }

                        // Delay cleanup to allow Sortable animation to complete
                        setTimeout(() => {
                            document.body.classList.remove('dragging', 'dragging-tile');
                            document.querySelectorAll('.unassigned-section').forEach(s => s.classList.remove('drag-nearby'));
                        }, 150);

                        // Clear tracked tile
                        draggedTileId = null;
                        draggedTileElement = null;
                    }
                });
            }
        }

        projectsList.appendChild(container);
    }

    /**
     * Render the unassigned tiles section above regular projects.
     * Always shows a tiles grid (even when empty) for drag-drop support.
     */
    async function renderUnassignedSection(unassignedProject) {
        // Remove existing unassigned section if any
        const existingSection = document.getElementById('unassigned-section');
        if (existingSection) existingSection.remove();

        const tiles = unassignedProject?.tiles || [];
        const section = document.createElement('div');
        section.id = 'unassigned-section';
        section.className = 'unassigned-section';
        section.dataset.projectId = unassignedProject?.id || '';

        if (tiles.length === 0) {
            section.classList.add('empty');
        }

        // Always create the structure with tiles grid for drop support
        section.innerHTML = `
            <div class="unassigned-header">
                <svg class="unassigned-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
                    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
                </svg>
                <span class="unassigned-label">Unsorted${tiles.length > 0 ? ` (${tiles.length})` : ''}</span>
            </div>
            <div class="unassigned-tiles tiles-grid"></div>
            <div class="unassigned-trigger-zone"></div>
        `;

        // Show drop zone when tile is dragged over section or trigger zone
        const triggerZone = section.querySelector('.unassigned-trigger-zone');

        const showDropZone = () => {
            if (draggedTileId && !draggedProjectId) {
                section.classList.add('drag-nearby');
            }
        };

        const hideDropZone = (e, element) => {
            // Only hide if leaving both section and trigger zone
            if (!section.contains(e.relatedTarget) && !triggerZone.contains(e.relatedTarget)) {
                section.classList.remove('drag-nearby');
            }
        };

        section.addEventListener('dragover', showDropZone);
        triggerZone.addEventListener('dragover', showDropZone);

        section.addEventListener('dragleave', (e) => hideDropZone(e, section));
        triggerZone.addEventListener('dragleave', (e) => hideDropZone(e, triggerZone));

        const tilesGrid = section.querySelector('.unassigned-tiles');

        if (tiles.length > 0) {
            // Sort and render tiles
            tiles.sort((a, b) => {
                const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
                const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
                return ao - bo || String(a.id).localeCompare(String(b.id));
            });

            for (const tile of tiles) {
                await createTileElement(tilesGrid, tile);
            }
        }

        // Make tiles sortable within this section (same group as project tiles)
        if (window.Sortable && unassignedProject?.id) {
            new Sortable(tilesGrid, {
                group: 'tiles',
                animation: 150,
                draggable: '.tile',
                ghostClass: 'sortable-ghost',
                chosenClass: 'sortable-chosen',
                dragClass: 'sortable-drag',
                emptyInsertThreshold: 50, // Pixels from empty zone to trigger insert
                onStart: function(evt) {
                    document.body.classList.add('dragging', 'dragging-tile');
                    section.classList.add('drag-active');
                    // Track dragged tile for sidebar drops
                    draggedTileId = evt.item.dataset.tileId;
                    draggedTileElement = evt.item;
                },
                onEnd: async function(evt) {
                    // If tile was dropped on sidebar, skip processing
                    if (tileDroppedOnSidebar) {
                        section.classList.remove('drag-active');
                        document.body.classList.remove('dragging', 'dragging-tile');
                        document.querySelectorAll('.unassigned-section').forEach(s => s.classList.remove('drag-nearby'));
                        tileDroppedOnSidebar = false;
                        draggedTileId = null;
                        draggedTileElement = null;
                        return;
                    }

                    // Move add-tile buttons to end in both containers
                    requestAnimationFrame(() => {
                        [evt.from, evt.to].forEach(container => {
                            const btn = container?.querySelector('.add-tile-button');
                            if (btn) container.appendChild(btn);
                        });
                    });

                    // Resequence tiles in both source and target containers
                    const resequenceContainer = async (container) => {
                        if (!container) return;
                        const parent = container.closest('.project') || container.closest('.unassigned-section');
                        if (!parent) return;
                        const projectId = String(parent.dataset.projectId);

                        const tileEls = [...container.querySelectorAll('.tile[data-tile-id]')];
                        await Promise.all(tileEls.map((el, idx) =>
                            db.tiles.update(el.dataset.tileId, {
                                projectId: projectId,
                                order: idx
                            })
                        ));
                    };

                    await resequenceContainer(evt.from);
                    await resequenceContainer(evt.to);

                    // Update empty state BEFORE removing drag classes
                    updateUnassignedEmptyState();

                    // Delay cleanup to allow Sortable animation to complete
                    setTimeout(() => {
                        section.classList.remove('drag-active');
                        document.body.classList.remove('dragging', 'dragging-tile');
                        document.querySelectorAll('.unassigned-section').forEach(s => s.classList.remove('drag-nearby'));
                        // Re-check empty state after drag classes are removed
                        updateUnassignedEmptyState();
                    }, 150);

                    // Update Quick Save count if tiles were moved from/to Quick Save
                    if (evt.from !== evt.to) {
                        await updateQuickSaveCount();
                    }

                    // Clear tracked tile
                    draggedTileId = null;
                    draggedTileElement = null;
                }
            });
        }

        // Insert at the top of projects list
        projectsList.insertBefore(section, projectsList.firstChild);
    }

    /**
     * Update the empty state class on unassigned section
     */
    function updateUnassignedEmptyState() {
        const section = document.getElementById('unassigned-section');
        if (!section) return;

        const tilesGrid = section.querySelector('.unassigned-tiles');
        const tileCount = tilesGrid?.querySelectorAll('.tile').length || 0;

        // Don't collapse to empty while dragging - wait until drop completes
        if (tileCount === 0 && !document.body.classList.contains('dragging-tile')) {
            section.classList.add('empty');
        } else if (tileCount > 0) {
            section.classList.remove('empty');
        }

        // Update count in label
        const label = section.querySelector('.unassigned-label');
        if (label) {
            label.textContent = `Unsorted${tileCount > 0 ? ` (${tileCount})` : ''}`;
        }
    }

    /**
     * Update the Quick Save count in the sidebar
     */
    async function updateQuickSaveCount() {
        const quickSaveItem = document.querySelector('.sidebar-item-unassigned');
        if (!quickSaveItem) return;

        const count = await db.tiles.where('projectId').equals(GLOBAL_UNASSIGNED_ID).count();
        const label = quickSaveItem.querySelector('.label');
        if (label) {
            label.textContent = `Quick Save${count > 0 ? ` (${count})` : ''}`;
        }
    }
    // Expose for use in bulk mode IIFE
    window.__updateQuickSaveCount = updateQuickSaveCount;

    async function loadProjects(projects = []) {
        if (projects && projects.length > 0) {
            // Sort projects by order before creating elements
            projects.sort((a, b) => {
                const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
                const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
                return ao - bo || String(a.id).localeCompare(String(b.id));
            });

            for (const projectData of projects) {
                // Load tiles for this project using Dexie
                let tiles = await db.tiles.where('projectId').equals(projectData.id).toArray();
                // Sort tiles by order property
                tiles.sort((a, b) => {
                    const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
                    const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
                    return ao - bo || String(a.id).localeCompare(String(b.id));
                });
                console.log(`Loaded ${tiles.length} tiles for project ${projectData.id}`);

                // Filter out internal/unsupported URLs (chrome://, chrome-extension://, etc.)
                const safeTiles = tiles.filter(t => {
                    try { const u = new URL(t.url); return u.protocol === 'http:' || u.protocol === 'https:'; }
                    catch { return false; }
                });

                // Sort tiles before creating project element
                sortTilesInPlace(safeTiles);

                // Create a new project object with tiles included
                const projectWithTiles = {
                    ...projectData,
                    tiles: safeTiles
                };

                createProjectElement(projectWithTiles);
            }
        }
    }

    async function loadProjectsForDashboard(dashboardId) {
        const allProjects = await db.projects.where('dashboardId').equals(dashboardId).toArray();

        // Separate unassigned project from regular projects
        const unassignedProject = allProjects.find(p => p.isUnassigned);
        const regularProjects = allProjects.filter(p => !p.isUnassigned);

        // Load tiles for unassigned project
        if (unassignedProject) {
            unassignedProject.tiles = await db.tiles.where('projectId').equals(unassignedProject.id).toArray();
        }

        // Render unassigned section
        await renderUnassignedSection(unassignedProject);

        // Load regular projects
        await loadProjects(regularProjects);
    }

    async function saveProject(projectData) {
        projectData.dashboardId = currentDashboardId;
        // Assign order so project appears at end of list
        projectData.order = await getNextProjectOrder(currentDashboardId);

        await db.projects.add(projectData);
        createProjectElement(projectData);
    }

    async function saveTile(projectId, tileData) {
        await db.tiles.put({
            id: tileData.id,
            name: tileData.name,
            url: tileData.url,
            projectId: projectId,
            dashboardId: currentDashboardId,
            order: Number.isFinite(+tileData.order) ? +tileData.order : 0
        });
    }

    // Project Creation
    async function createNewProject() {
        const projectName = projectNameInput.value.trim();

        if (projectName) {
            const projectData = {
                id: Date.now().toString(),
                name: projectName,
                tiles: []
            };

            await saveProject(projectData);
            closeProjectModalHandler();
        }
    }

    function createProjectElement(projectData) {
        const project = document.createElement("div");
        project.className = "project";
        if (projectData.collapsed) {
            project.classList.add("collapsed");
        }
        project.dataset.projectId = projectData.id;

        const projectHeader = document.createElement("div");
        projectHeader.className = "project-header";

        const dragHandle = document.createElement("div");
        dragHandle.className = "project-drag-handle";

        const projectTitle = document.createElement("h2");
        projectTitle.className = "project-title";
        projectTitle.textContent = projectData.name;
        projectTitle.title = "Double-click to edit";

        // Double-click to edit project title
        projectTitle.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            editProjectTitleInline(projectTitle, projectData);
        });

        // Notes toggle button
        const notesToggle = document.createElement("button");
        notesToggle.className = "project-notes-toggle";
        if (projectData.notes) {
            notesToggle.classList.add("has-notes");
        }
        notesToggle.title = "Project notes";
        notesToggle.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;

        // Notes section (hidden by default)
        const notesSection = document.createElement("div");
        notesSection.className = "project-notes-section";
        const notesTextarea = document.createElement("textarea");
        notesTextarea.className = "project-notes-textarea";
        notesTextarea.placeholder = "Add notes about this project...";
        notesTextarea.value = projectData.notes || "";
        notesSection.appendChild(notesTextarea);

        // Toggle notes visibility
        notesToggle.addEventListener("click", async (e) => {
            e.stopPropagation();

            // If project is collapsed, expand it and open notes
            const wasCollapsed = project.classList.contains("collapsed");
            if (wasCollapsed) {
                project.classList.remove("collapsed");
                // Save expanded state using Dexie
                await db.projects.update(projectData.id, { collapsed: false });
                // Always open notes when expanding from collapsed
                notesSection.classList.add("expanded");
                notesToggle.classList.add("active");
                notesTextarea.focus();
            } else {
                // Normal toggle behavior
                notesSection.classList.toggle("expanded");
                notesToggle.classList.toggle("active");
                if (notesSection.classList.contains("expanded")) {
                    notesTextarea.focus();
                }
            }
        });

        // Auto-save notes on blur
        notesTextarea.addEventListener("blur", async () => {
            const newNotes = notesTextarea.value.trim();
            await db.projects.update(projectData.id, { notes: newNotes });
            // Update has-notes indicator
            if (newNotes) {
                notesToggle.classList.add("has-notes");
            } else {
                notesToggle.classList.remove("has-notes");
            }
        });

        const menuTrigger = document.createElement("button");
        menuTrigger.className = "project-menu-trigger";
        menuTrigger.innerHTML = "⋮";
        menuTrigger.addEventListener("click", (e) => {
            e.stopPropagation();
            closeAllMenus(); // Close any open menus first
            menuTrigger.classList.toggle("active");

            // Check if menu would go off-screen and flip if needed
            if (menuTrigger.classList.contains("active")) {
                requestAnimationFrame(() => {
                    const menu = menuTrigger.nextElementSibling;
                    if (menu) {
                        const rect = menu.getBoundingClientRect();
                        const viewportHeight = window.innerHeight;
                        if (rect.bottom > viewportHeight) {
                            menu.classList.add("flip-up");
                        } else {
                            menu.classList.remove("flip-up");
                        }
                    }
                });
            }
        });

        // Collapse caret
        const collapseCaret = document.createElement("button");
        collapseCaret.className = "project-collapse-caret";
        collapseCaret.title = "Collapse/Expand project";
        collapseCaret.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
        collapseCaret.addEventListener("click", async (e) => {
            e.stopPropagation();
            project.classList.toggle("collapsed");
            const isCollapsed = project.classList.contains("collapsed");
            // Save collapsed state using Dexie
            await db.projects.update(projectData.id, { collapsed: isCollapsed });
        });

        const menu = document.createElement("div");
        menu.className = "project-menu";

            // Project edit button (refactored with fresh DB fetch)
        const editButton = document.createElement("button");
        editButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Rename`;
        editButton.onclick = async (e) => {
        e.stopPropagation();
        closeAllMenus();

        const currentProjectEl = editButton.closest('.project');
        if (!currentProjectEl) return;

        const freshProject = await getProjectById(currentProjectEl.dataset.projectId);
        if (!freshProject) return;

        projectModal.style.display = "flex";
        projectModal.querySelector('h2').textContent = "Edit Project";
        projectNameInput.value = freshProject.name;
        validateProjectInput();

        // Reset submit button to avoid stacked listeners
        const newSubmitBtn = submitProjectBtn.cloneNode(true);
        submitProjectBtn.parentNode.replaceChild(newSubmitBtn, submitProjectBtn);
        submitProjectBtn = newSubmitBtn;

        submitProjectBtn.addEventListener('click', async () => {
            const newName = projectNameInput.value.trim();
            if (!newName) return;

            await db.projects.update(freshProject.id, { name: newName });
            const titleEl = currentProjectEl.querySelector('.project-title');
            if (titleEl) titleEl.textContent = newName;

            closeProjectModalHandler();

            // Reset the submit button back to "create" mode
            const oldBtn = submitProjectBtn;
            submitProjectBtn = oldBtn.cloneNode(true);
            oldBtn.parentNode.replaceChild(submitProjectBtn, oldBtn);
            submitProjectBtn.addEventListener('click', createNewProject);
        });
    };


    // Open All in Tabs button
    const openAllButton = document.createElement("button");
    openAllButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> Open All in Tabs`;
    openAllButton.onclick = async (e) => {
        e.stopPropagation();
        closeAllMenus();

        const currentProjectEl = openAllButton.closest('.project');
        if (!currentProjectEl) return;

        const tiles = await db.tiles.where('projectId').equals(currentProjectEl.dataset.projectId).toArray();
        if (tiles.length === 0) return;

        // Sort tiles by order to match display order
        tiles.sort((a, b) => {
            const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
            const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
            return ao - bo;
        });

        // Open each tile URL in a new tab (using chrome.tabs API for proper ordering)
        for (const tile of tiles) {
            if (tile.url) {
                if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
                    await chrome.tabs.create({ url: tile.url, active: false });
                } else {
                    window.open(tile.url, '_blank', 'noopener,noreferrer');
                }
            }
        }
    };

    // Move to Space button
    const moveButton = document.createElement("button");
    moveButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Move to Space`;
    moveButton.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllMenus();

        let dashboards = await db.dashboards.toArray();
        if (dashboards.length > 0) {
            const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
            dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));
        }

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'flex';

        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.width = '280px';

        const title = document.createElement('h2');
        title.textContent = 'Move to Space';

        const select = document.createElement('select');
        select.style.cssText = `
            width: 100%;
            margin-bottom: 20px;
            padding: 8px;
            font-size: 14px;
        `;

        dashboards.forEach(dashboard => {
            if (dashboard.id !== currentDashboardId) {
                const option = document.createElement('option');
                option.value = dashboard.id;
                option.textContent = dashboard.name;
                select.appendChild(option);
            }
        });

        const buttons = document.createElement('div');
        buttons.className = 'modal-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'cancel-button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => modal.remove();

        const moveBtn = document.createElement('button');
        moveBtn.className = 'done-button enabled';
        moveBtn.textContent = 'Move';
        moveBtn.onclick = async () => {
            const selectedDashboardId = select.value;
            if (!selectedDashboardId) return;

            const currentProjectEl = moveButton.closest('.project');
            if (!currentProjectEl) return;

            const freshProject = await getProjectById(currentProjectEl.dataset.projectId);
            if (!freshProject) return;

            const newOrder = await getNextProjectOrder(selectedDashboardId);

            // Update project's dashboardId and order
            await db.projects.update(freshProject.id, {
                dashboardId: selectedDashboardId,
                order: newOrder
            });

            // Update all tiles' dashboardId
            await db.tiles.where('projectId').equals(freshProject.id).modify({
                dashboardId: selectedDashboardId
            });

            // Remove project from current view
            currentProjectEl.remove();
            modal.remove();
        };

        buttons.appendChild(cancelBtn);
        buttons.appendChild(moveBtn);

        content.appendChild(title);
        content.appendChild(select);
        content.appendChild(buttons);
        modal.appendChild(content);
        document.body.appendChild(modal);
    };

    const copyButton = document.createElement("button");
    copyButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy to Space`;
    copyButton.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllMenus();

        let dashboards = await db.dashboards.toArray();
        if (dashboards.length > 0) {
            const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
            dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));
        }

        // Create space selection modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'flex';

        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.width = '280px';

        const title = document.createElement('h2');
        title.textContent = 'Select Space';

        const select = document.createElement('select');
        select.style.cssText = `
            width: 100%;
            margin-bottom: 20px;
            padding: 8px;
            font-size: 14px;
        `;

        dashboards.forEach(dashboard => {
            if (dashboard.id !== currentDashboardId) {
                const option = document.createElement('option');
                option.value = dashboard.id;
                option.textContent = dashboard.name;
                select.appendChild(option);
            }
        });

        const buttons = document.createElement('div');
        buttons.className = 'modal-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'cancel-button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => modal.remove();

        const copyBtn = document.createElement('button');
        copyBtn.className = 'done-button enabled';
        copyBtn.textContent = 'Copy';
        copyBtn.onclick = async () => {
            const selectedDashboardId = select.value;
            if (!selectedDashboardId) return;

            const currentProjectEl = copyButton.closest('.project');
            if (!currentProjectEl) return;

            const freshProject = await getProjectById(currentProjectEl.dataset.projectId);
            if (!freshProject) return;

            // Get all tiles for this project
            const tiles = await db.tiles.where('projectId').equals(freshProject.id).toArray();

            // Build new project
            const newProjectData = {
                id: Date.now().toString(),
                name: freshProject.name,
                dashboardId: selectedDashboardId
            };

            // Add new project
            await db.projects.add(newProjectData);

            // Copy tiles to the new project
            for (const tile of tiles) {
                await db.tiles.add({
                    ...tile,
                    id: Date.now().toString() + Math.random(),
                    projectId: newProjectData.id,
                    dashboardId: selectedDashboardId
                });
            }

            modal.remove();
        };

        buttons.appendChild(cancelBtn);
        buttons.appendChild(copyBtn);

        content.appendChild(title);
        content.appendChild(select);
        content.appendChild(buttons);
        modal.appendChild(content);
        document.body.appendChild(modal);
    };

        const removeButton = document.createElement("button");
        removeButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Remove`;
        removeButton.onclick = async (e) => {
            e.stopPropagation();
            if (confirm('Are you sure you want to remove this project?')) {
                // Capture data for undo
                const deletedProjectData = { ...projectData };
                const deletedTiles = await db.tiles.where('projectId').equals(projectData.id).toArray();
                const parentContainer = project.parentElement;
                const nextSibling = project.nextElementSibling;

                // Delete tiles first, then project
                await db.tiles.where('projectId').equals(projectData.id).delete();
                await db.projects.delete(projectData.id);
                project.remove();

                const tileCount = deletedTiles.length;
                const message = tileCount > 0
                    ? `Project deleted (${tileCount} tile${tileCount > 1 ? 's' : ''})`
                    : 'Project deleted';

                showUndoToast(message, async () => {
                    // Restore project to Dexie
                    await db.projects.add(deletedProjectData);
                    // Restore all tiles
                    for (const tile of deletedTiles) {
                        await db.tiles.add(tile);
                    }
                    // Reload to restore DOM
                    await loadDashboards();
                });
            }
        };

        menu.appendChild(editButton);
        menu.appendChild(openAllButton);
        menu.appendChild(moveButton);
        menu.appendChild(copyButton);
        menu.appendChild(removeButton);

        // Bulk selection checkbox
        const bulkCheckbox = document.createElement('input');
        bulkCheckbox.type = 'checkbox';
        bulkCheckbox.className = 'bulk-checkbox';
        bulkCheckbox.dataset.type = 'project';
        bulkCheckbox.dataset.id = projectData.id;

        projectHeader.appendChild(dragHandle);
        projectHeader.appendChild(bulkCheckbox);
        projectHeader.appendChild(projectTitle);
        projectHeader.appendChild(notesToggle);
        projectHeader.appendChild(collapseCaret);
        projectHeader.appendChild(menuTrigger);
        projectHeader.appendChild(menu);

        var tilesContainer = document.createElement("div");
        tilesContainer.className = "tiles-container";

        // Initialize Sortable for tiles
        new Sortable(tilesContainer, {
            animation: 150,
            draggable: '.tile',
            handle: '.tile',
            group: 'tiles',
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            dragClass: 'sortable-drag',
            filter: '.add-tile-button', // Prevent sorting on add button
            preventOnFilter: false,
            onStart: function(evt) {
                document.body.classList.add('dragging', 'dragging-tile');
                // Disable all add buttons during drag
                document.querySelectorAll('.add-tile-button').forEach(btn => {
                    btn.classList.add('dragging-disabled');
                });

                // Track dragged tile for sidebar drops
                draggedTileId = evt.item.dataset.tileId;
                draggedTileElement = evt.item;

                if (!draggedTileId) {
                    console.error('Dragged tile missing ID:', evt.item);
                }
            },
            onEnd: async function (evt) {
                // Re-enable all add buttons after drag
                requestAnimationFrame(() => {
                    document.querySelectorAll('.add-tile-button').forEach(btn => {
                        btn.classList.remove('dragging-disabled');
                        btn.classList.remove('hover');
                    });
                });

                // If tile was dropped on sidebar, skip Sortable processing
                if (tileDroppedOnSidebar) {
                    document.body.classList.remove('dragging', 'dragging-tile');
                    document.querySelectorAll('.unassigned-section').forEach(s => s.classList.remove('drag-nearby'));
                    tileDroppedOnSidebar = false;
                    draggedTileId = null;
                    draggedTileElement = null;
                    return;
                }

                // Move add tile buttons to the end in both source and target containers
                requestAnimationFrame(() => {
                    [evt.from, evt.to].forEach(container => {
                        const addTileButton = container?.querySelector('.add-tile-button');
                        if (addTileButton) {
                            container.appendChild(addTileButton);
                        }
                    });
                });

                const resequence = async (container) => {
                    if (!container) return;
                    // Check for project or unassigned section
                    const projEl = container.closest('.project') || container.closest('.unassigned-section');
                    if (!projEl) return;
                    const projectId = String(projEl.dataset.projectId);

                    // only real tiles; skip placeholders
                    const tileEls = [...container.querySelectorAll('.tile[data-tile-id]')];
                    await Promise.all(tileEls.map((el, idx) =>
                        db.tiles.update(el.dataset.tileId, {
                            projectId: projectId,
                            order: idx
                        })
                    ));
                };

                // handle same-project and cross-project moves
                await resequence(evt.from);
                await resequence(evt.to);

                // Update unassigned section empty state BEFORE removing drag classes
                updateUnassignedEmptyState();

                // Update Quick Save count if tiles were moved from/to Quick Save
                if (evt.from !== evt.to) {
                    await updateQuickSaveCount();
                }

                // Delay cleanup to allow Sortable animation to complete
                setTimeout(() => {
                    document.body.classList.remove('dragging', 'dragging-tile');
                    document.querySelectorAll('.unassigned-section').forEach(s => {
                        s.classList.remove('drag-nearby');
                        s.classList.remove('drag-active');
                    });
                    // Re-check empty state after drag classes are removed
                    updateUnassignedEmptyState();
                }, 150);

                // Clear tracked tile
                draggedTileId = null;
                draggedTileElement = null;
            },
            onMove: function(evt) {
                return !evt.related.classList.contains('add-tile-button');
            }
        });

        if (projectData.tiles) {
            projectData.tiles.forEach(tileData => {
                createTileElement(tilesContainer, tileData);
            });
        }

        const addTileButton = document.createElement("button");
        addTileButton.className = "add-tile-button";
        addTileButton.innerHTML = "+";
        addTileButton.addEventListener("click", function() {
            currentProjectContainer = tilesContainer;
            currentProjectId = projectData.id;
            tileModal.style.display = "flex";
            tileNameInput.focus();
        });

        project.appendChild(projectHeader);
        project.appendChild(notesSection);
        project.appendChild(tilesContainer);
        tilesContainer.appendChild(addTileButton);

        document.getElementById("projects-list").appendChild(project);
    }

    // Tile Creation
    async function createNewTile() {
        const tileName = tileNameInput.value.trim();
        const tileUrl = tileUrlInput.value.trim();

        if (
            currentProjectContainer &&
            currentProjectId &&
            tileName &&
            (() => { try { const u = new URL(tileUrl); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } })()
          ) {
            // Get max order from DB for proper order assignment
            const existingTiles = await db.tiles.where('projectId').equals(currentProjectId).toArray();
            const maxOrder = existingTiles.reduce((max, t) => Math.max(max, t.order ?? -1), -1);

            const tileData = {
                id: Date.now().toString(),
                name: tileName,
                url: tileUrl,
                projectId: currentProjectId,
                dashboardId: currentDashboardId,
                order: maxOrder + 1
            };

            await saveTile(currentProjectId, tileData);
            createTileElement(currentProjectContainer, tileData);
            closeTileModalHandler();
        }
    }

    async function createNewTileFromPopup() {
        const tileName = popupTileNameInput.value.trim();
        const tileUrl = popupTileUrlInput.value.trim();

        if (
            currentProjectContainer &&
            currentProjectId &&
            tileName &&
            (() => { try { const u = new URL(tileUrl); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } })()
          ) {
            // Get max order from DB for proper order assignment
            const existingTiles = await db.tiles.where('projectId').equals(currentProjectId).toArray();
            const maxOrder = existingTiles.reduce((max, t) => Math.max(max, t.order ?? -1), -1);

            const tileData = {
                id: Date.now().toString(),
                name: tileName,
                url: tileUrl,
                projectId: currentProjectId,
                dashboardId: currentDashboardId,
                order: maxOrder + 1
            };

            await saveTile(currentProjectId, tileData);
            createTileElement(currentProjectContainer, tileData);
            closePopupModalHandler();
        }
    }

    // Function to sort tiles by order with stable tiebreaker
    function sortTilesInPlace(tiles) {
        // coerce in place so later code always sees numbers
        for (const t of tiles) t.order = Number.isFinite(+t.order) ? +t.order : Number.MAX_SAFE_INTEGER;
        tiles.sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
    }

    // Function to generate a color based on domain
    function generateColorFromString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        const hue = Math.abs(hash % 360);
        return `hsl(${hue}, 65%, 65%)`; // Light, pastel color
    }

    // Function to truncate text with ellipsis
    function truncateText(text, maxLength) {
        if (!text) return '';
        return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    }

    // Function to get site initials
    function getSiteInitials(domain) {
        try {
            const parts = domain.replace('www.', '').split('.');
            if (parts.length > 1) {
                return parts[0].substring(0, 2).toUpperCase();
            }
            return domain.substring(0, 2).toUpperCase();
        } catch (e) {
            return 'LT';
        }
    }

    //    // Function to handle clicking outside menu
        function handleClickOutside(e, menuTrigger, menu) {
        if (!menu.contains(e.target) && e.target !== menuTrigger) {
            menuTrigger.classList.remove("active");
        }
    }

    // Dashboard modal functionality only (sidebar handles dashboard management now)

    dashboardNameInput.addEventListener("input", validateDashboardInput);

    dashboardNameInput.addEventListener("keydown", function(event) {
        if (event.key === 'Enter' && !submitDashboardBtn.disabled) {
            submitDashboardBtn.click();
        }
    });

    submitDashboardBtn.addEventListener("click", createNewDashboard);
    closeDashboardModal.addEventListener("click", closeDashboardModalHandler);

    function validateDashboardInput() {
        const isValid = dashboardNameInput.value.trim() !== "";
        submitDashboardBtn.disabled = !isValid;
        submitDashboardBtn.classList.toggle("enabled", isValid);
    }

    function closeDashboardModalHandler() {
        dashboardModal.style.display = "none";
        dashboardNameInput.value = "";
        validateDashboardInput();
    }
    async function getNextDashboardOrder() {
        const dashboards = await db.dashboards.toArray();
        const max = dashboards
          .map(d => Number.isFinite(+d.order) ? +d.order : -1)
          .reduce((a, b) => Math.max(a, b), -1);
        return max + 1;
    }

    async function createNewDashboard() {
        const dashboardName = dashboardNameInput.value.trim();
        if (!dashboardName) return;

        const order = await getNextDashboardOrder();

        const dashboardData = {
          id: Date.now().toString(),
          name: dashboardName,
          projects: [],
          order
        };

        await db.dashboards.add(dashboardData);
        localStorage.setItem('currentDashboardId', dashboardData.id);
        currentDashboardId = dashboardData.id;
        await loadDashboards();
        closeDashboardModalHandler();
    }
      
    function closeAllMenus() {
        const allMenuTriggers = document.querySelectorAll('.project-menu-trigger, .tile-menu-trigger, .dashboard-menu-trigger');
        allMenuTriggers.forEach(trigger => trigger.classList.remove('active'));
        const allMenus = document.querySelectorAll('.project-menu, .tile-menu, .dashboard-actions-menu');
        allMenus.forEach(menu => menu.classList.remove('active'));
    }

    // Close any open menus (project/tile/dashboard) on true outside-click or Esc
    (() => {
        if (document.__ltGlobalMenuCloser) return; // idempotent

        const isMenuOrTrigger = (el) =>
            el.closest('.project-menu, .tile-menu, .dashboard-actions-menu, .project-menu-trigger, .tile-menu-trigger, .dashboard-menu-trigger');

        const isNotesArea = (el) =>
            el.closest('.project-notes-section, .project-notes-toggle');

        const outsideClose = (e) => {
            if (isMenuOrTrigger(e.target)) return; // clicked inside a menu or on its trigger
            closeAllMenus();                       // otherwise, close everything

            // Collapse project notes if clicking outside of notes area
            if (!isNotesArea(e.target)) {
                document.querySelectorAll('.project-notes-section.expanded').forEach(notes => {
                    notes.classList.remove('expanded');
                });
            }
        };

        // Use capture so we're not defeated by stopPropagation in nested UIs
        document.addEventListener('pointerdown', outsideClose, true);

        // Bonus: Esc closes menus too
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeAllMenus();
        }, true);

        // Nice-to-have: close menus when you scroll either pane
        const killOnScroll = () => closeAllMenus();
        document.getElementById('main')?.addEventListener('scroll', killOnScroll, { passive: true });
        document.getElementById('sidebar')?.querySelector('.sidebar-list')
            ?.addEventListener('scroll', killOnScroll, { passive: true });

        document.__ltGlobalMenuCloser = true;
    })();

    function resetDashboardButton() {
        // Reset the submit button to create mode
        const oldBtn = submitDashboardBtn;
        submitDashboardBtn = oldBtn.cloneNode(true);
        oldBtn.parentNode.replaceChild(submitDashboardBtn, oldBtn);
        submitDashboardBtn.addEventListener('click', createNewDashboard);
        validateDashboardInput(); // Ensure proper state
    }

    // Manage Dashboards Modal Functions
    async function openManageDashboardsModal() {
        const modal = document.getElementById('manage-dashboards-modal');
        const list = document.getElementById('manage-dashboards-list');

        // Clear existing content
        list.innerHTML = '';

        try {
            // Get all dashboards
            let dashboards = await db.dashboards.toArray();

            // Sort dashboards by order property
            if (dashboards && dashboards.length > 0) {
                const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
                dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));
            }

            // Get project counts for each dashboard
            for (const dashboard of dashboards) {
                dashboard.projectCount = await db.projects.where('dashboardId').equals(dashboard.id).count();
            }

            // Create dashboard items
            dashboards.forEach((dashboard, index) => {
                createManageDashboardItem(dashboard, list, index);
            });

            // Initialize sortable
            new Sortable(list, {
                animation: 150,
                handle: '.dashboard-drag-handle',
                ghostClass: 'manage-dashboards-sortable-ghost',
                onEnd: function(evt) {
                    updateDashboardOrder(evt);
                }
            });

            // Add bulk actions bar before the list
            const bulkActionsBar = document.createElement('div');
            bulkActionsBar.className = 'bulk-actions-bar';
            bulkActionsBar.id = 'bulk-actions-bar';
            bulkActionsBar.innerHTML = `
                <div class="bulk-actions-left">
                    <span class="selected-count">0 selected</span>
                    <div class="select-controls">
                        <button class="select-control-btn" id="select-all">Select All</button>
                        <button class="select-control-btn" id="select-none">Select None</button>
                    </div>
                </div>
                <div class="bulk-actions-right">
                    <button class="bulk-action-btn primary" id="bulk-delete">Delete Selected</button>
                </div>
            `;

            // Insert before the list
            list.parentNode.insertBefore(bulkActionsBar, list);

            // Add bulk action listeners
            document.getElementById('select-all').addEventListener('click', selectAllDashboards);
            document.getElementById('select-none').addEventListener('click', selectNoneDashboards);
            document.getElementById('bulk-delete').addEventListener('click', bulkDeleteDashboards);

            modal.style.display = 'flex';
        } catch (error) {
            console.error('Error loading dashboards for management:', error);
            alert('Error loading spaces. Please try again.');
        }
    }

    function updateBulkActionsVisibility() {
        const checkboxes = document.querySelectorAll('.dashboard-checkbox');
        const selectedCheckboxes = document.querySelectorAll('.dashboard-checkbox:checked');
        const bulkActionsBar = document.getElementById('bulk-actions-bar');
        const selectedCount = document.querySelector('.selected-count');

        if (selectedCheckboxes.length > 0) {
            bulkActionsBar.classList.add('active');
            selectedCount.textContent = `${selectedCheckboxes.length} selected`;
        } else {
            bulkActionsBar.classList.remove('active');
        }
    }

    function selectAllDashboards() {
        const checkboxes = document.querySelectorAll('.dashboard-checkbox');
        checkboxes.forEach(checkbox => {
            checkbox.checked = true;
            checkbox.closest('.manage-dashboard-item').classList.add('selected');
        });
        updateBulkActionsVisibility();
    }

    function selectNoneDashboards() {
        const checkboxes = document.querySelectorAll('.dashboard-checkbox');
        checkboxes.forEach(checkbox => {
            checkbox.checked = false;
            checkbox.closest('.manage-dashboard-item').classList.remove('selected');
        });
        updateBulkActionsVisibility();
    }

    async function bulkDeleteDashboards() {
        const selectedCheckboxes = document.querySelectorAll('.dashboard-checkbox:checked');
        const selectedIds = Array.from(selectedCheckboxes).map(cb => cb.dataset.dashboardId);

        if (selectedIds.length === 0) return;

        // Check if trying to delete all spaces
        const allDashboards = document.querySelectorAll('.dashboard-checkbox');
        if (selectedIds.length >= allDashboards.length) {
            alert("Cannot delete all spaces. At least one space must remain.");
            return;
        }

        // Check if current space is being deleted
        const currentDashboardBeingDeleted = selectedIds.includes(currentDashboardId);
        const originalCurrentDashboardId = currentDashboardId;

        if (confirm(`Are you sure you want to delete ${selectedIds.length} space${selectedIds.length > 1 ? 's' : ''}? All projects and tiles in them will be removed.`)) {
            try {
                // Capture data for undo
                const deletedDashboards = [];
                const deletedProjects = [];
                const deletedTiles = [];

                for (const dashboardId of selectedIds) {
                    const dashboard = await db.dashboards.get(dashboardId);
                    if (dashboard) deletedDashboards.push(dashboard);

                    const projects = await db.projects.where('dashboardId').equals(dashboardId).toArray();
                    deletedProjects.push(...projects);

                    for (const project of projects) {
                        const tiles = await db.tiles.where('projectId').equals(project.id).toArray();
                        deletedTiles.push(...tiles);
                    }
                }

                // If current dashboard is being deleted, switch to a remaining one first
                if (currentDashboardBeingDeleted) {
                    const remainingCheckboxes = Array.from(allDashboards).filter(cb => !selectedIds.includes(cb.dataset.dashboardId));
                    if (remainingCheckboxes.length > 0) {
                        const newCurrentId = remainingCheckboxes[0].dataset.dashboardId;
                        localStorage.setItem('currentDashboardId', newCurrentId);
                        currentDashboardId = newCurrentId;

                        // Clear projects list
                        projectsList.innerHTML = '';
                    }
                }

                // Delete each selected dashboard
                for (const dashboardId of selectedIds) {
                    // Delete all tiles for projects in this dashboard
                    const projects = await db.projects.where('dashboardId').equals(dashboardId).toArray();
                    for (const project of projects) {
                        await db.tiles.where('projectId').equals(project.id).delete();
                    }
                    // Delete all projects for this dashboard
                    await db.projects.where('dashboardId').equals(dashboardId).delete();
                    // Delete the dashboard
                    await db.dashboards.delete(dashboardId);

                    // Remove from UI immediately
                    const item = document.querySelector(`[data-dashboard-id="${dashboardId}"]`);
                    if (item) {
                        item.remove();
                    }
                }

                // Update UI after all deletions are complete
                if (currentDashboardBeingDeleted) {
                    // Wait a bit to ensure all transactions are complete
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await loadDashboards();
                } else {
                    await updateDashboardSelector();
                }

                // Refresh the manage dashboards modal to show updated state
                const modal = document.getElementById('manage-dashboards-modal');
                if (modal.style.display === 'flex') {
                    // Close and reopen the modal to refresh its contents
                    modal.style.display = 'none';
                    // Small delay to ensure DOM cleanup
                    setTimeout(() => {
                        openManageDashboardsModal();
                    }, 50);
                }

                const spaceCount = deletedDashboards.length;
                const projectCount = deletedProjects.length;
                const tileCount = deletedTiles.length;
                let message = `${spaceCount} space${spaceCount > 1 ? 's' : ''} deleted`;
                if (projectCount > 0 || tileCount > 0) {
                    const parts = [];
                    if (projectCount > 0) parts.push(`${projectCount} project${projectCount > 1 ? 's' : ''}`);
                    if (tileCount > 0) parts.push(`${tileCount} tile${tileCount > 1 ? 's' : ''}`);
                    message += ` (${parts.join(', ')})`;
                }

                showUndoToast(message, async () => {
                    // Restore dashboards
                    for (const dashboard of deletedDashboards) {
                        await db.dashboards.add(dashboard);
                    }
                    // Restore projects
                    for (const project of deletedProjects) {
                        await db.projects.add(project);
                    }
                    // Restore tiles
                    for (const tile of deletedTiles) {
                        await db.tiles.add(tile);
                    }
                    // Restore current dashboard if it was deleted
                    if (currentDashboardBeingDeleted) {
                        localStorage.setItem('currentDashboardId', originalCurrentDashboardId);
                        currentDashboardId = originalCurrentDashboardId;
                    }
                    await loadDashboards();
                    // Refresh manage modal if open
                    const modal = document.getElementById('manage-dashboards-modal');
                    if (modal.style.display === 'flex') {
                        modal.style.display = 'none';
                        setTimeout(() => openManageDashboardsModal(), 50);
                    }
                });

            } catch (error) {
                console.error('Error bulk deleting dashboards:', error);
                alert('Error deleting spaces. Please try again.');
            }
        }
    }

    function createManageDashboardItem(dashboard, container, index) {
        const item = document.createElement('div');
        item.className = 'manage-dashboard-item';
        item.dataset.dashboardId = dashboard.id;

        item.innerHTML = `
            <input type="checkbox" class="dashboard-checkbox" data-dashboard-id="${dashboard.id}">
            <div class="dashboard-drag-handle">⋮⋮</div>
            <div class="manage-dashboard-info">
                <div class="manage-dashboard-name">${escapeHtml(dashboard.name)}</div>
                <input type="text" class="manage-dashboard-name-input" value="">
                <div class="manage-dashboard-projects">${dashboard.projectCount} project${dashboard.projectCount !== 1 ? 's' : ''}</div>
            </div>
            <div class="manage-dashboard-actions">
                <div class="normal-actions">
                    <button class="manage-action-btn edit-btn">Edit</button>
                    <button class="manage-action-btn delete-btn">Delete</button>
                </div>
                <div class="edit-actions">
                    <button class="manage-action-btn save-btn">Save</button>
                    <button class="manage-action-btn cancel-btn">Cancel</button>
                </div>
            </div>
        `;

        // Add event listeners
        const checkbox = item.querySelector('.dashboard-checkbox');
        const editBtn = item.querySelector('.edit-btn');
        const deleteBtn = item.querySelector('.delete-btn');
        const saveBtn = item.querySelector('.save-btn');
        const cancelBtn = item.querySelector('.cancel-btn');
        const nameInput = item.querySelector('.manage-dashboard-name-input');
        nameInput.value = dashboard.name; // Set via DOM to prevent attribute injection

        // Handle checkbox selection
        checkbox.addEventListener('change', () => {
            item.classList.toggle('selected', checkbox.checked);
            updateBulkActionsVisibility();
        });

        editBtn.addEventListener('click', () => {
            item.classList.add('editing');
            setTimeout(() => {
                nameInput.focus();
                nameInput.select();
            }, 10);
        });

        deleteBtn.addEventListener('click', () => {
            deleteDashboardFromManage(dashboard.id, item);
        });

        saveBtn.addEventListener('click', () => {
            saveDashboardName(dashboard.id, nameInput.value.trim(), item);
        });

        cancelBtn.addEventListener('click', () => {
            nameInput.value = dashboard.name;
            item.classList.remove('editing');
        });

        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                saveDashboardName(dashboard.id, nameInput.value.trim(), item);
            } else if (e.key === 'Escape') {
                nameInput.value = dashboard.name;
                item.classList.remove('editing');
            }
        });

        container.appendChild(item);
    }

    async function saveDashboardName(dashboardId, newName, item) {
        if (!newName) {
            alert('Space name cannot be empty');
            return;
        }

        try {
            await db.dashboards.update(dashboardId, { name: newName });
            // Update the manage modal display
            item.querySelector('.manage-dashboard-name').textContent = newName;
            item.classList.remove('editing');

            // Only update the space selector without reloading projects
            await updateDashboardSelector();
        } catch (error) {
            console.error('Error saving space name:', error);
            alert('Error saving space name. Please try again.');
        }
    }

    async function deleteDashboardFromManage(dashboardId, item) {
        try {
            const dashboards = await db.dashboards.toArray();

            if (dashboards.length <= 1) {
                alert("Cannot delete the last space");
                return;
            }

            if (confirm('Are you sure you want to delete this space? All projects and tiles in it will be removed.')) {
                // Capture data for undo
                const deletedDashboard = await db.dashboards.get(dashboardId);
                const deletedProjects = await db.projects.where('dashboardId').equals(dashboardId).toArray();
                const deletedTiles = [];
                for (const project of deletedProjects) {
                    const tiles = await db.tiles.where('projectId').equals(project.id).toArray();
                    deletedTiles.push(...tiles);
                }
                const wasCurrentDashboard = dashboardId === currentDashboardId;

                // Delete all tiles for projects in this dashboard
                const projects = await db.projects.where('dashboardId').equals(dashboardId).toArray();
                for (const project of projects) {
                    await db.tiles.where('projectId').equals(project.id).delete();
                }
                // Delete all projects for this dashboard
                await db.projects.where('dashboardId').equals(dashboardId).delete();
                // Delete the dashboard
                await db.dashboards.delete(dashboardId);

                // Remove from UI
                const itemEl =
                  item ||
                  document.querySelector(`.manage-dashboard-item[data-dashboard-id="${dashboardId}"]`);
                itemEl?.remove();

                // If this was the current dashboard, switch to another one first
                if (dashboardId === currentDashboardId) {
                    const remainingDashboards = dashboards.filter(d => d.id !== dashboardId);
                    if (remainingDashboards.length > 0) {
                        // Find the index of the current dashboard being deleted
                        const currentIndex = dashboards.findIndex(d => d.id === dashboardId);

                        // Choose the next dashboard using a more reliable method
                        let newCurrentId;
                        if (remainingDashboards.length > 0) {
                            if (currentIndex < remainingDashboards.length) {
                                // If there are enough remaining dashboards after current position, pick that one
                                newCurrentId = remainingDashboards[currentIndex].id;
                            } else {
                                // Otherwise pick the last remaining dashboard
                                newCurrentId = remainingDashboards[remainingDashboards.length - 1].id;
                            }
                        } else {
                            // This shouldn't happen since we check for at least 2 dashboards before deletion
                            console.error('No remaining dashboards after deletion');
                            return;
                        }

                        localStorage.setItem('currentDashboardId', newCurrentId);
                        currentDashboardId = newCurrentId;

                        // Clear projects list
                        projectsList.innerHTML = '';

                        // Only call loadDashboards to update the selector, it will load projects automatically
                        loadDashboards();
                    }
                } else {
                    // Just update the selector since we're not on the deleted dashboard
                    await updateDashboardSelector();
                }

                const projectCount = deletedProjects.length;
                const tileCount = deletedTiles.length;
                let message = 'Space deleted';
                if (projectCount > 0 || tileCount > 0) {
                    const parts = [];
                    if (projectCount > 0) parts.push(`${projectCount} project${projectCount > 1 ? 's' : ''}`);
                    if (tileCount > 0) parts.push(`${tileCount} tile${tileCount > 1 ? 's' : ''}`);
                    message = `Space deleted (${parts.join(', ')})`;
                }

                showUndoToast(message, async () => {
                    // Restore dashboard
                    await db.dashboards.add(deletedDashboard);
                    // Restore projects
                    for (const project of deletedProjects) {
                        await db.projects.add(project);
                    }
                    // Restore tiles
                    for (const tile of deletedTiles) {
                        await db.tiles.add(tile);
                    }
                    // Reload UI
                    if (wasCurrentDashboard) {
                        localStorage.setItem('currentDashboardId', dashboardId);
                        currentDashboardId = dashboardId;
                    }
                    await loadDashboards();
                    // Refresh manage modal if open
                    const modal = document.getElementById('manage-dashboards-modal');
                    if (modal.style.display === 'flex') {
                        modal.style.display = 'none';
                        setTimeout(() => openManageDashboardsModal(), 50);
                    }
                });
            }
        } catch (error) {
            console.error('Error deleting dashboard:', error);
            alert('Error deleting space. Please try again.');
        }
    }

    async function updateDashboardOrder(evt) {
        try {
            const items = Array.from(evt.to.children);

            // Update order for each dashboard item
            await Promise.all(items.map((item, index) =>
                db.dashboards.update(item.dataset.dashboardId, { order: index })
            ));

            // Only update the dashboard selector without reloading projects
            await updateDashboardSelector();
        } catch (error) {
            console.error('Error updating dashboard order:', error);
        }
    }

    async function updateDashboardSelector() {
        try {
            let dashboards = await db.dashboards.toArray();

            // Sort dashboards by order property
            if (dashboards && dashboards.length > 0) {
                const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
                dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));
            }

            if (dashboards && dashboards.length > 0) {
                const currentId = localStorage.getItem('currentDashboardId') || dashboards[0].id;

                // Validate that the current dashboard still exists
                const validCurrentId = dashboards.find(d => d.id === currentId) ? currentId : dashboards[0].id;
                if (validCurrentId !== currentId) {
                    localStorage.setItem('currentDashboardId', validCurrentId);
                    currentDashboardId = validCurrentId;
                }

                renderSidebar(dashboards, validCurrentId);
            }
        } catch (error) {
            console.error('Error updating dashboard selector:', error);
        }
    }

    async function tryChromeFavicon(url) {
        if (chrome.tabs) {
            try {
                const tabs = await chrome.tabs.query({});
                const matchingTab = tabs.find(tab => tab.url === url);
                if (matchingTab?.favIconUrl) {
                    return matchingTab.favIconUrl;
                }
            } catch (e) {
                console.log('Chrome API not available for favicon');
            }
        }
        return null;
    }

    async function createTileElement(container, tileData) {
        if (!tileData.id) {
            tileData.id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        }
        const tile = document.createElement("div");
        tile.className = "tile";
        tile.dataset.tileId = String(tileData.id); // 👈 critical for resequencing

        const menuTrigger = document.createElement("button");
        menuTrigger.className = "tile-menu-trigger";
        menuTrigger.innerHTML = "⋮";

        const menu = document.createElement("div");
        menu.className = "tile-menu";

        menuTrigger.addEventListener("click", function(e) {
            e.preventDefault();
            e.stopPropagation();
            closeAllMenus();
            const allTriggers = document.querySelectorAll('.tile-menu-trigger');
            allTriggers.forEach(trigger => {
                if (trigger !== menuTrigger) {
                    trigger.classList.remove('active');
                }
            });
            menuTrigger.classList.toggle("active");
        });

        const editButton = document.createElement("button");
        editButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit`;
        editButton.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            menuTrigger.classList.remove('active'); // Close the menu

            // Always get the CURRENT container and project ID at the time of clicking edit
            // This ensures we're editing the tile in its current location, not its original one
            const currentContainer = tile.closest('.tiles-container');
            const currentProject = tile.closest('.project');
            if (!currentContainer || !currentProject) return;

            currentProjectContainer = currentContainer;
            currentProjectId = currentProject.dataset.projectId;

            // Fetch the latest data before populating the modal
            const freshTile = await getTileById(tileData.id);
            if (!freshTile) return;

            tileModal.style.display = "flex";
            tileModal.querySelector('h2').textContent = "Edit Tile";
            tileNameInput.value = freshTile.name;
            tileUrlInput.value = freshTile.url;
            validateTileInputs();

            // Create a new button to avoid event listener buildup
            const newSubmitBtn = submitTileBtn.cloneNode(true);
            submitTileBtn.parentNode.replaceChild(newSubmitBtn, submitTileBtn);
            submitTileBtn = newSubmitBtn;

            submitTileBtn.addEventListener('click', async function editTileHandler() {
                const newName = tileNameInput.value.trim();
                const newUrl = tileUrlInput.value.trim();

                if (newName && isValidUrl(newUrl)) {
                    await db.tiles.update(tileData.id, { name: newName, url: newUrl });

                    // Update the closure data so click handler uses new URL
                    tileData.name = newName;
                    tileData.url = newUrl;

                    tile.querySelector('.tile-name').textContent = newName;
                    tile.setAttribute('title', newName);
                    closeTileModalHandler();

                    // Reset the submit button to create mode
                    const oldBtn = submitTileBtn;
                    submitTileBtn = oldBtn.cloneNode(true);
                    oldBtn.parentNode.replaceChild(submitTileBtn, oldBtn);
                    submitTileBtn.addEventListener('click', createNewTile);
                    menuTrigger.classList.remove('active');
                }
            });
        };

        const removeButton = document.createElement("button");
        removeButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Remove`;
        removeButton.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (confirm('Are you sure you want to remove this tile?')) {
                // Capture data for undo
                const deletedTileData = { ...tileData };
                const parentContainer = tile.parentElement;
                const nextSibling = tile.nextElementSibling;

                await db.tiles.delete(tileData.id);
                tile.remove();
                // Update Quick Save count in case this was a Quick Save tile
                await updateQuickSaveCount();

                showUndoToast('Tile deleted', async () => {
                    // Restore tile to Dexie
                    await db.tiles.add(deletedTileData);
                    // Reload to restore DOM
                    await loadDashboards();
                    await updateQuickSaveCount();
                });
            }
        };

        menu.appendChild(editButton);
        menu.appendChild(removeButton);
        tile.appendChild(menuTrigger);
        tile.appendChild(menu);

        // Bulk selection checkbox
        const bulkCheckbox = document.createElement('input');
        bulkCheckbox.type = 'checkbox';
        bulkCheckbox.className = 'bulk-checkbox';
        bulkCheckbox.dataset.type = 'tile';
        bulkCheckbox.dataset.id = tileData.id;
        tile.appendChild(bulkCheckbox);

        document.addEventListener("click", function(e) {
            if (!menu.contains(e.target) && e.target !== menuTrigger) {
                menuTrigger.classList.remove("active");
            }
        });

        tile.addEventListener("click", function(e) {
            // In bulk mode, clicking the tile toggles selection
            if (document.body.classList.contains('bulk-mode')) {
                if (!e.target.classList.contains('bulk-checkbox')) {
                    e.preventDefault();
                    bulkCheckbox.checked = !bulkCheckbox.checked;
                    bulkCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
                }
                return;
            }
            if (!e.target.closest('.tile-menu') && !e.target.closest('.tile-menu-trigger') && !e.target.closest('.tile-name')) {
                e.preventDefault(); // keep drag/click behavior clean
                // Always open tiles in a new tab
                const win = window.open(tileData.url, '_blank', 'noopener,noreferrer');
                // (optional) focus the new tab if the browser allows
                win?.focus?.();
            }
        });

        const thumbnailElement = document.createElement("div");
        thumbnailElement.className = "tile-thumbnail";

        // Get hostname for favicon logic
        const safeHost = (() => { 
            try { 
                return new URL(tileData.url).hostname; 
            } catch { 
                return ''; 
            } 
        })();

        // Helper function to show initials
        const showInitials = () => {
            const initials = getSiteInitials(safeHost) || 'LT';
            const bgColor = generateColorFromString(safeHost || 'lifetiles');
            thumbnailElement.style.backgroundImage = 'none';
            thumbnailElement.style.backgroundColor = bgColor;
            thumbnailElement.innerHTML = `<span class="tile-initials">${escapeHtml(initials)}</span>`;
        };

        // If tile has a good stored favicon, apply immediately (no flash)
        // Skip deprecated/problematic URLs - those need re-fetching
        const storedFavicon = tileData.favicon;
        const hasGoodFavicon = storedFavicon && !isDeprecatedFavicon(storedFavicon);

        if (hasGoodFavicon) {
            thumbnailElement.style.backgroundImage = `url('${storedFavicon}')`;
            thumbnailElement.style.backgroundColor = 'transparent';
        } else {
            // Show initials as placeholder while we fetch
            showInitials();
        }

        const nameElement = document.createElement("div");
        nameElement.className = "tile-name";
        nameElement.textContent = truncateText(tileData.name, 60);
        nameElement.setAttribute("title", "Double-click to edit");
        tile.setAttribute("title", tileData.name);

        // Double-click to edit tile name
        nameElement.addEventListener("dblclick", (e) => {
            e.preventDefault();
            e.stopPropagation();
            editTileNameInline(nameElement, tileData, tile);
        });

        tile.appendChild(thumbnailElement);
        tile.appendChild(nameElement);

        // 🔑 Insert NOW to preserve the sorted order
        const addTileButton = container.querySelector('.add-tile-button');
        container.insertBefore(tile, addTileButton);

        // Load favicon asynchronously (uses consolidated favicon module)
        if (safeHost && !hasGoodFavicon) {
            (async () => {
                try {
                    // Check DB cache first
                    let favicon = await checkFaviconCache(safeHost);
                    // If not cached, run discovery
                    if (!favicon) {
                        favicon = await loadFaviconForHost(safeHost, tileData.url);
                    }
                    // Apply if found
                    if (favicon) {
                        thumbnailElement.style.backgroundImage = `url('${favicon}')`;
                        thumbnailElement.style.backgroundColor = 'transparent';
                        thumbnailElement.innerHTML = '';
                    }
                } catch {}
            })();
        }
    }
// --- helper: get current tile order from DOM (ignores add-tile button) ---
function getOrderedTileIds(containerEl) {
    return Array.from(containerEl.children)
      .filter((el) => el.classList.contains('tile') && !el.classList.contains('add-tile-button'))
      .map((el) => el.dataset.tileId)
      .filter(Boolean);
  }
  async function updateProjectOrder(evt) {
    try {
      const container = document.getElementById('projects-list');
      const projectEls = Array.from(container.querySelectorAll('.project'));

      await Promise.all(projectEls.map((el, index) =>
        db.projects.update(el.dataset.projectId, { order: index })
      ));
    } catch (e) {
      console.error('updateProjectOrder failed:', e);
    }
  }
async function updateTileOrder(evt, fromProjectId, toProjectId) {
        try {
            // Ensure we have valid project IDs
            if (!fromProjectId || !toProjectId) {
                console.error('Invalid project IDs:', fromProjectId, toProjectId);
                return;
            }

            // Get the dragged tile ID from the event
            const draggedTileId = evt.item.dataset.tileId;
            if (!draggedTileId) {
                console.error('No tile ID found on dragged element');
                return;
            }

            console.log(`Updating tile order: ${draggedTileId} from ${fromProjectId} to ${toProjectId}`);

            // Use separate transactions to avoid conflicts
            if (fromProjectId !== toProjectId) {
                // Handle cross-project move
                await handleCrossProjectMove(draggedTileId, fromProjectId, toProjectId, evt);
            } else {
                // Handle same-project reorder
                await handleSameProjectReorder(toProjectId, evt);
            }

            // Remove hover states from all add-tile buttons after drag
            document.querySelectorAll('.add-tile-button').forEach(button => {
                button.classList.remove('hover');
            });

        } catch (error) {
            console.error('Error updating tile order:', error);
        }
    }

    async function handleCrossProjectMove(draggedTileId, fromProjectId, toProjectId, evt) {
        // Update the dragged tile's project
        await db.tiles.update(draggedTileId, {
            projectId: toProjectId,
            dashboardId: currentDashboardId
        });

        // Then reorder both projects
        await handleSameProjectReorder(fromProjectId, { from: evt.from });
        await handleSameProjectReorder(toProjectId, { to: evt.to });
    }

    async function handleSameProjectReorder(projectId, evt) {
        const container = evt.to || evt.from;
        if (!container) return;

        const tileElements = Array.from(container.children).filter(
            el => el.classList.contains('tile') && el.dataset.tileId
        );
        if (!tileElements.length) return;

        await Promise.all(tileElements.map((el, index) =>
            db.tiles.update(el.dataset.tileId, {
                projectId: String(projectId),
                order: Number(index)
            })
        ));
    }

    async function getProjectTiles(projectId) {
        return db.tiles.where('projectId').equals(projectId).toArray();
    }
});

  // Close manage dashboards modal
    const closeManageDashboardsBtn = document.getElementById('close-manage-dashboards');
    if (closeManageDashboardsBtn) {
        closeManageDashboardsBtn.addEventListener('click', () => {
            document.getElementById('manage-dashboards-modal').style.display = 'none';
            // Reset bulk actions state when modal is closed
            const bulkActionsBar = document.getElementById('bulk-actions-bar');
            if (bulkActionsBar) {
                bulkActionsBar.remove();
            }
        });

    // Async functions for getting fresh project and tile data to the edit modals
    }
    async function getTileById(id) {
        return db.tiles.get(id) || null;
    }

    async function getProjectById(id) {
        return db.projects.get(id) || null;
    }


// Import/Export functions moved from options.js
async function exportDashboardsJSON() {
    const dashboards = await db.dashboards.toArray();
    const projects = await db.projects.toArray();
    const tiles = await db.tiles.toArray();

    const exportData = {
        dashboards,
        projects,
        tiles,
        exportDate: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linktiles-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showStatus('Data exported successfully!');
}

async function importDashboardsJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const importData = JSON.parse(e.target.result);

                // Check for and remove empty default space before importing
                const existingDashboards = await db.dashboards.toArray();
                for (const dash of existingDashboards) {
                    if (dash.name === 'Personal' || dash.name === 'My Dashboard') {
                        const projectCount = await db.projects.where('dashboardId').equals(dash.id).count();
                        if (projectCount === 0) {
                            await db.dashboards.delete(dash.id);
                        }
                    }
                }

                // Import new data while preserving existing
                for (const dashboard of importData.dashboards) {
                    const newDashboard = {
                        ...dashboard,
                        id: Date.now().toString() + Math.random() // Generate new ID to avoid conflicts
                    };
                    await db.dashboards.add(newDashboard);

                    // Update project references to new dashboard ID
                    const dashboardProjects = importData.projects.filter(p => p.dashboardId === dashboard.id);

                    // Ensure the unassigned project for this dashboard exists first
                    const unassignedProjectId = `${newDashboard.id}-unassigned`;
                    const existingUnassigned = await db.projects.get(unassignedProjectId);
                    if (!existingUnassigned) {
                        await db.projects.add({
                            id: unassignedProjectId,
                            dashboardId: newDashboard.id,
                            name: 'Unsorted',
                            isUnassigned: true,
                            order: -1
                        });
                    }

                    let projectOrder = 0;
                    for (const project of dashboardProjects) {
                        // Skip unassigned projects - we already created one above with the correct ID
                        if (project.isUnassigned) {
                            // But still import the tiles from the unassigned project
                            const projectTiles = importData.tiles.filter(t => t.projectId === project.id);
                            const existingUnassignedTiles = await db.tiles.where('projectId').equals(unassignedProjectId).toArray();
                            let unassignedOrder = existingUnassignedTiles.length;
                            for (const tile of projectTiles) {
                                // Skip tiles with non-http(s) URLs
                                if (tile.url && isInternalUrl(tile.url)) continue;
                                await db.tiles.add({
                                    ...tile,
                                    id: Date.now().toString() + Math.random(),
                                    projectId: unassignedProjectId,
                                    dashboardId: newDashboard.id,
                                    order: unassignedOrder++
                                });
                            }
                            continue;
                        }

                        const newProject = {
                            ...project,
                            id: Date.now().toString() + Math.random(),
                            dashboardId: newDashboard.id,
                            order: Number.isFinite(+project.order) ? project.order : projectOrder++
                        };
                        await db.projects.add(newProject);

                        // Update tile references to new project ID
                        const projectTiles = importData.tiles.filter(t => t.projectId === project.id);
                        for (const tile of projectTiles) {
                            // Skip tiles with non-http(s) URLs
                            if (tile.url && isInternalUrl(tile.url)) continue;
                            await db.tiles.add({
                                ...tile,
                                id: Date.now().toString() + Math.random(),
                                projectId: newProject.id,
                                dashboardId: newDashboard.id
                            });
                        }
                    }
                }

                // Import Quick Save tiles (global-unassigned project)
                const quickSaveProject = importData.projects?.find(p =>
                    p.id === 'global-unassigned' || p.dashboardId === null
                );
                if (quickSaveProject) {
                    // Ensure global-unassigned project exists
                    const existingGlobal = await db.projects.get('global-unassigned');
                    if (!existingGlobal) {
                        await db.projects.add({
                            id: 'global-unassigned',
                            dashboardId: null,
                            name: 'Unsorted',
                            isUnassigned: true,
                            order: -1
                        });
                    }

                    // Get existing Quick Save tile count for ordering
                    const existingTiles = await db.tiles.where('projectId').equals('global-unassigned').toArray();
                    let nextOrder = existingTiles.length;

                    // Import Quick Save tiles
                    const quickSaveTiles = importData.tiles?.filter(t =>
                        t.projectId === quickSaveProject.id || t.projectId === 'global-unassigned'
                    ) || [];
                    for (const tile of quickSaveTiles) {
                        // Skip tiles with non-http(s) URLs
                        if (tile.url && isInternalUrl(tile.url)) continue;
                        await db.tiles.add({
                            ...tile,
                            id: Date.now().toString() + Math.random(),
                            projectId: 'global-unassigned',
                            dashboardId: null,
                            order: nextOrder++
                        });
                    }
                }

                showStatus('Data imported successfully! Reloading page...');
                setTimeout(() => window.location.reload(), 2000);
            } catch (error) {
                console.error('Import error:', error);
                showStatus('Error importing data');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

function processBookmarksBar(bookmarkBar) {
    const projects = [];
    const looseBookmarks = []; // Tiles to go to Unsorted

    bookmarkBar.children.forEach(child => {
        if (child.url && !isInternalUrl(child.url)) {
            // Single bookmark goes into Unsorted
            looseBookmarks.push({
                id: crypto.randomUUID(),
                name: child.title,
                url: child.url
            });
        } else if (child.children) {
            // Folder becomes a new project
            const tiles = [];
            child.children.forEach(bookmark => {
                if (bookmark.url && !isInternalUrl(bookmark.url)) {
                    tiles.push({
                        id: crypto.randomUUID(),
                        name: bookmark.title,
                        url: bookmark.url
                    });
                }
            });
            if (tiles.length > 0) {
                projects.push({
                    id: crypto.randomUUID(),
                    name: child.title,
                    tiles: tiles
                });
            }
        }
    });

    return { projects, looseBookmarks };
}

async function importGoogleBookmarks() {
    if (!chrome?.bookmarks) {
        alert('Bookmark access not available. This feature requires the Chrome extension.');
        return;
    }

    // Get dashboards to check if we need to show selection modal
    let dashboards;
    try {
        dashboards = await db.dashboards.toArray();
    } catch (error) {
        console.error('Error loading dashboards:', error);
        return;
    }

    // Function to perform the actual import
    const performImport = async (selectedDashboardId) => {
        chrome.bookmarks.getTree(async function(bookmarkTree) {
            try {
                // The bookmarks bar is the first child in the bookmark tree
                const bookmarkBar = bookmarkTree[0].children[0];
                const { projects, looseBookmarks } = processBookmarksBar(bookmarkBar);

                // Get existing projects to determine starting order
                const existingProjects = await db.projects.where('dashboardId').equals(selectedDashboardId).toArray();

                // Calculate next order value from existing projects
                let maxOrder = -1;
                existingProjects.forEach(p => {
                    const order = Number.isFinite(+p.order) ? +p.order : -1;
                    if (order > maxOrder) maxOrder = order;
                });
                let nextOrder = maxOrder + 1;

                // Add each project and its tiles
                for (const project of projects) {
                    project.dashboardId = selectedDashboardId;
                    project.order = nextOrder++;
                    // Save project
                    await db.projects.add(project);

                    // Add tiles for this project
                    if (project.tiles) {
                        for (const tile of project.tiles) {
                            tile.projectId = project.id;
                            tile.dashboardId = selectedDashboardId;
                            await db.tiles.put(tile);
                        }
                    }
                }

                // Add loose bookmarks to Unsorted
                if (looseBookmarks.length > 0) {
                    const unassignedProjectId = `${selectedDashboardId}-unassigned`;

                    // Ensure unassigned project exists
                    const existingUnassigned = await db.projects.get(unassignedProjectId);
                    if (!existingUnassigned) {
                        await db.projects.add({
                            id: unassignedProjectId,
                            dashboardId: selectedDashboardId,
                            name: 'Unsorted',
                            isUnassigned: true,
                            order: -1
                        });
                    }

                    // Get existing tiles to determine order
                    const existingTiles = await db.tiles.where('projectId').equals(unassignedProjectId).toArray();
                    let tileOrder = existingTiles.length;

                    for (const tile of looseBookmarks) {
                        tile.projectId = unassignedProjectId;
                        tile.dashboardId = selectedDashboardId;
                        tile.order = tileOrder++;
                        await db.tiles.put(tile);
                    }
                }

                showStatus('Bookmarks imported successfully!');

                // Delay reload to allow status message to be seen
                setTimeout(() => {
                    window.location.reload();
                }, 2000);
            } catch (error) {
                console.error('Error importing bookmarks:', error);
                showStatus('Error importing bookmarks');
            }
        });
    };

    // If only one dashboard, skip the selection modal
    if (dashboards.length === 1) {
        await performImport(dashboards[0].id);
        return;
    }

    // Sort dashboards by order to match sidebar
    dashboards.sort((a, b) => {
        const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
        const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
        return ao - bo;
    });

    // Create and show dashboard selection modal
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.width = '320px';

    const title = document.createElement('h2');
    title.textContent = 'Select Space';
    content.appendChild(title);

    // Create list container using target-tree styles
    const listEl = document.createElement('div');
    listEl.className = 'target-tree';

    let selectedDashboard = dashboards[0];

    // Add each dashboard as a selectable row
    dashboards.forEach((dashboard, index) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'target-tree-project' + (index === 0 ? ' selected' : '');
        rowEl.dataset.dashboardId = dashboard.id;
        rowEl.innerHTML = `
            <svg class="target-tree-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="7" height="7"></rect>
                <rect x="14" y="3" width="7" height="7"></rect>
                <rect x="14" y="14" width="7" height="7"></rect>
                <rect x="3" y="14" width="7" height="7"></rect>
            </svg>
            <span>${escapeHtml(dashboard.name)}</span>
        `;
        rowEl.addEventListener('click', () => {
            listEl.querySelectorAll('.target-tree-project.selected').forEach(el => {
                el.classList.remove('selected');
            });
            rowEl.classList.add('selected');
            selectedDashboard = dashboard;
            confirmBtn.disabled = false;
            confirmBtn.classList.add('enabled');
            // Hide new space input if visible
            if (newSpaceInput.style.display !== 'none') {
                newSpaceInput.style.display = 'none';
                newSpaceInput.value = '';
            }
        });
        listEl.appendChild(rowEl);
    });

    // Add "+ New Space" option
    const newSpaceEl = document.createElement('div');
    newSpaceEl.className = 'target-tree-new-project';
    newSpaceEl.innerHTML = `
        <svg class="target-tree-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        <span>New Space</span>
    `;

    // Input for new space name (hidden initially)
    const newSpaceInput = document.createElement('input');
    newSpaceInput.type = 'text';
    newSpaceInput.className = 'target-tree-new-project-input';
    newSpaceInput.placeholder = 'Enter space name';
    newSpaceInput.style.display = 'none';
    newSpaceInput.style.margin = '8px 12px 8px 36px';
    newSpaceInput.style.width = 'calc(100% - 48px)';

    newSpaceEl.addEventListener('click', () => {
        // Deselect all
        listEl.querySelectorAll('.target-tree-project.selected').forEach(el => {
            el.classList.remove('selected');
        });
        selectedDashboard = null;
        newSpaceInput.style.display = 'block';
        newSpaceInput.focus();
        confirmBtn.disabled = false;
        confirmBtn.classList.add('enabled');
    });

    listEl.appendChild(newSpaceEl);
    listEl.appendChild(newSpaceInput);
    content.appendChild(listEl);

    // Modal buttons
    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'modal-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel-button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => modal.remove();

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'done-button enabled';
    confirmBtn.textContent = 'Import';
    confirmBtn.onclick = async () => {
        let targetDashboardId;

        if (selectedDashboard) {
            targetDashboardId = selectedDashboard.id;
        } else {
            // Creating new space
            const newName = newSpaceInput.value.trim();
            if (!newName) {
                newSpaceInput.focus();
                return;
            }

            const maxOrder = dashboards.reduce((max, d) => Math.max(max, d.order ?? 0), -1);
            const newDashboardId = Date.now().toString();
            await db.dashboards.add({
                id: newDashboardId,
                name: newName,
                order: maxOrder + 1
            });

            // Create unassigned project for this dashboard
            await db.projects.add({
                id: `${newDashboardId}-unassigned`,
                dashboardId: newDashboardId,
                name: 'Unsorted',
                isUnassigned: true,
                order: -1
            });

            targetDashboardId = newDashboardId;
        }

        modal.remove();
        await performImport(targetDashboardId);
    };

    buttonsDiv.appendChild(cancelBtn);
    buttonsDiv.appendChild(confirmBtn);
    content.appendChild(buttonsDiv);

    modal.appendChild(content);
    document.body.appendChild(modal);
}

function showStatus(message) {
    // Create a temporary status element since we don't have one in main page
    const status = document.createElement('div');
    status.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #4CAF50;
        color: white;
        padding: 12px 24px;
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        z-index: 9999;
        font-size: 14px;
        opacity: 0;
        transition: opacity 0.3s ease;
    `;
    status.textContent = message;
    document.body.appendChild(status);

    requestAnimationFrame(() => {
        status.style.opacity = '1';
        setTimeout(() => {
            status.style.opacity = '0';
            setTimeout(() => {
                document.body.removeChild(status);
            }, 300);
        }, 3000);
    });
}

function showUndoToast(message, undoCallback, duration = 7000) {
    const existingToast = document.querySelector('.undo-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'undo-toast';

    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;

    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Undo';
    undoBtn.onmouseenter = () => undoBtn.style.textDecoration = 'underline';
    undoBtn.onmouseleave = () => undoBtn.style.textDecoration = 'none';

    toast.appendChild(messageSpan);
    toast.appendChild(undoBtn);
    document.body.appendChild(toast);

    let timeoutId;

    const dismissToast = () => {
        clearTimeout(timeoutId);
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    };

    undoBtn.onclick = async () => {
        dismissToast();
        if (undoCallback) await undoCallback();
    };

    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        timeoutId = setTimeout(dismissToast, duration);
    });
}

// ===== Bulk Actions Mode =====

(function initBulkMode() {
    const bulkSelectBtn = document.getElementById('bulk-select');
    const bulkActionBar = document.getElementById('bulk-action-bar');
    const bulkToggleAllBtn = document.getElementById('bulk-toggle-all');
    const selectionCountEl = document.getElementById('selection-count');
    const bulkDeleteBtn = document.getElementById('bulk-delete');
    const bulkMoveBtn = document.getElementById('bulk-move');
    const bulkCopyBtn = document.getElementById('bulk-copy');
    const bulkCancelBtn = document.getElementById('bulk-cancel');

    // Target selection modal elements
    const bulkTargetModal = document.getElementById('bulk-target-modal');
    const bulkTargetTitle = document.getElementById('bulk-target-title');
    const bulkTargetSelect = document.getElementById('bulk-target-select');
    const bulkTargetCancel = document.getElementById('bulk-target-cancel');
    const bulkTargetConfirm = document.getElementById('bulk-target-confirm');

    if (!bulkSelectBtn) return; // Not on main page

    function enterBulkMode() {
        document.body.classList.add('bulk-mode');
        bulkSelectBtn.classList.add('hidden');
        bulkActionBar.classList.remove('hidden');
        updateSelectionCount();
    }

    function exitBulkMode() {
        document.body.classList.remove('bulk-mode');
        bulkSelectBtn.classList.remove('hidden');
        bulkActionBar.classList.add('hidden');

        // Clear all selections
        document.querySelectorAll('.bulk-checkbox').forEach(cb => {
            cb.checked = false;
        });
        document.querySelectorAll('.bulk-selected').forEach(el => {
            el.classList.remove('bulk-selected');
        });
        updateSelectionCount();
    }
    // Expose for use outside bulk mode IIFE
    window.__exitBulkMode = exitBulkMode;

    function getSelectedItems() {
        const selected = [];
        document.querySelectorAll('.bulk-checkbox:checked').forEach(cb => {
            selected.push({
                type: cb.dataset.type,
                id: cb.dataset.id,
                element: cb.closest(cb.dataset.type === 'project' ? '.project' : '.tile')
            });
        });
        return selected;
    }

    function updateSelectionCount() {
        const selected = getSelectedItems();
        const count = selected.length;
        selectionCountEl.textContent = `${count} selected`;

        // Enable/disable action buttons
        const hasSelection = count > 0;
        bulkDeleteBtn.disabled = !hasSelection;
        bulkMoveBtn.disabled = !hasSelection;
        bulkCopyBtn.disabled = !hasSelection;

        // Update toggle all button state
        const allCheckboxes = document.querySelectorAll('.bulk-checkbox');
        const allSelected = allCheckboxes.length > 0 &&
            Array.from(allCheckboxes).every(cb => cb.checked);
        bulkToggleAllBtn.classList.toggle('all-selected', allSelected);
    }

    // Toggle bulk mode
    bulkSelectBtn.addEventListener('click', () => {
        if (document.body.classList.contains('bulk-mode')) {
            exitBulkMode();
        } else {
            enterBulkMode();
        }
    });

    // Cancel button in bulk action bar
    bulkCancelBtn.addEventListener('click', () => {
        exitBulkMode();
    });

    // Toggle all selection
    bulkToggleAllBtn.addEventListener('click', () => {
        const allCheckboxes = document.querySelectorAll('.bulk-checkbox');
        const allSelected = allCheckboxes.length > 0 &&
            Array.from(allCheckboxes).every(cb => cb.checked);

        // If all selected, deselect all; otherwise select all
        const newState = !allSelected;
        allCheckboxes.forEach(cb => {
            cb.checked = newState;
            const type = cb.dataset.type;
            const element = cb.closest(type === 'project' ? '.project' : '.tile');
            if (element) {
                element.classList.toggle('bulk-selected', newState);
            }
        });

        updateSelectionCount();
    });

    // Handle checkbox changes using event delegation
    document.addEventListener('change', (e) => {
        if (!e.target.classList.contains('bulk-checkbox')) return;

        const checkbox = e.target;
        const type = checkbox.dataset.type;
        const element = checkbox.closest(type === 'project' ? '.project' : '.tile');

        if (element) {
            element.classList.toggle('bulk-selected', checkbox.checked);
        }

        // Hierarchical selection logic
        if (type === 'project') {
            // Check/uncheck all tiles in this project
            const projectEl = checkbox.closest('.project');
            if (projectEl) {
                const tileCheckboxes = projectEl.querySelectorAll('.tile .bulk-checkbox');
                tileCheckboxes.forEach(cb => {
                    cb.checked = checkbox.checked;
                    cb.closest('.tile')?.classList.toggle('bulk-selected', checkbox.checked);
                });
            }
        } else if (type === 'tile') {
            // Update parent project checkbox state
            const projectEl = checkbox.closest('.project');
            if (projectEl) {
                const projectCheckbox = projectEl.querySelector('.project-header .bulk-checkbox');
                const allTileCheckboxes = projectEl.querySelectorAll('.tile .bulk-checkbox');
                const tileCount = allTileCheckboxes.length;
                const allChecked = Array.from(allTileCheckboxes).every(cb => cb.checked);

                if (projectCheckbox) {
                    // Only auto-check project if 2+ tiles and all are checked
                    // For 1-tile projects, don't auto-check (allows selecting just the tile)
                    // Always uncheck project if any tile is unchecked
                    if (allChecked && tileCount >= 2) {
                        projectCheckbox.checked = true;
                        projectEl.classList.add('bulk-selected');
                    } else if (!allChecked) {
                        projectCheckbox.checked = false;
                        projectEl.classList.remove('bulk-selected');
                    }
                }
            }
        }

        updateSelectionCount();
    });

    // Prevent checkbox clicks from bubbling to parent handlers
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('bulk-checkbox')) {
            e.stopPropagation();
        }
    }, true);

    // Delete action
    bulkDeleteBtn.addEventListener('click', async () => {
        let selected = getSelectedItems();
        if (selected.length === 0) return;

        // Deduplicate: remove tiles whose parent project is also selected
        const selectedProjectIds = new Set(selected.filter(s => s.type === 'project').map(s => s.id));
        selected = selected.filter(s => {
            if (s.type === 'tile') {
                const parentProject = s.element?.closest('.project');
                const parentId = parentProject?.dataset.projectId;
                return !selectedProjectIds.has(parentId);
            }
            return true;
        });

        const projectCount = selected.filter(s => s.type === 'project').length;
        const tileCount = selected.filter(s => s.type === 'tile').length;

        let message = 'Are you sure you want to delete ';
        const parts = [];
        if (projectCount > 0) parts.push(`${projectCount} project${projectCount > 1 ? 's' : ''}`);
        if (tileCount > 0) parts.push(`${tileCount} tile${tileCount > 1 ? 's' : ''}`);
        message += parts.join(' and ') + '?';

        if (!confirm(message)) return;

        // Capture data for undo
        const deletedProjects = [];
        const deletedProjectTiles = []; // tiles belonging to deleted projects
        const deletedTiles = []; // individually deleted tiles
        const deletedElements = []; // for DOM restoration

        // Capture project data and their tiles
        const projectIds = selected.filter(s => s.type === 'project').map(s => s.id);
        for (const projectId of projectIds) {
            const project = await db.projects.get(projectId);
            if (project) {
                deletedProjects.push(project);
                const tiles = await db.tiles.where('projectId').equals(projectId).toArray();
                deletedProjectTiles.push(...tiles);
            }
        }

        // Capture individual tile data
        const tileIds = selected.filter(s => s.type === 'tile').map(s => s.id);
        for (const tileId of tileIds) {
            const tile = await db.tiles.get(tileId);
            if (tile) deletedTiles.push(tile);
        }

        // Capture DOM positions before deletion
        for (const item of selected) {
            if (item.element) {
                deletedElements.push({
                    type: item.type,
                    id: item.id,
                    parentElement: item.element.parentElement,
                    nextSibling: item.element.nextElementSibling
                });
            }
        }

        // Delete projects and their tiles
        for (const projectId of projectIds) {
            await db.tiles.where('projectId').equals(projectId).delete();
            await db.projects.delete(projectId);
        }

        // Delete individual tiles
        for (const tileId of tileIds) {
            await db.tiles.delete(tileId);
        }

        // Remove elements from DOM
        selected.forEach(item => {
            if (item.element) {
                item.element.remove();
            }
        });

        // Update Quick Save count in case any were Quick Save tiles
        if (window.__updateQuickSaveCount) await window.__updateQuickSaveCount();

        exitBulkMode();

        const totalCount = selected.length;
        let undoMessage = `Deleted ${totalCount} item${totalCount > 1 ? 's' : ''}`;

        showUndoToast(undoMessage, async () => {
            // Restore projects
            for (const project of deletedProjects) {
                await db.projects.add(project);
            }
            // Restore tiles from deleted projects
            for (const tile of deletedProjectTiles) {
                await db.tiles.add(tile);
            }
            // Restore individually deleted tiles
            for (const tile of deletedTiles) {
                await db.tiles.add(tile);
            }

            // Reload the current dashboard to restore DOM
            await loadDashboards();

            if (window.__updateQuickSaveCount) await window.__updateQuickSaveCount();
        });
    });

    // Helper: Deduplicate selection (remove tiles whose parent project is selected)
    function deduplicateSelection(selected) {
        const selectedProjectIds = new Set(selected.filter(s => s.type === 'project').map(s => s.id));
        return selected.filter(s => {
            if (s.type === 'tile') {
                const parentProject = s.element?.closest('.project');
                const parentId = parentProject?.dataset.projectId;
                return !selectedProjectIds.has(parentId);
            }
            return true;
        });
    }

    // Move action
    bulkMoveBtn.addEventListener('click', async () => {
        let selected = deduplicateSelection(getSelectedItems());
        if (selected.length === 0) return;

        // Determine what we're moving
        const hasProjects = selected.some(s => s.type === 'project');
        const hasTiles = selected.some(s => s.type === 'tile');

        if (hasProjects && hasTiles) {
            alert('Please select only projects or only tiles to move, not both.');
            return;
        }

        if (hasProjects) {
            // Move projects to another dashboard
            await showMoveProjectsDialog(selected.filter(s => s.type === 'project'));
        } else {
            // Move tiles to another project
            await showMoveTilesDialog(selected.filter(s => s.type === 'tile'));
        }
    });

    // Copy action
    bulkCopyBtn.addEventListener('click', async () => {
        let selected = deduplicateSelection(getSelectedItems());
        if (selected.length === 0) return;

        // Determine what we're copying
        const hasProjects = selected.some(s => s.type === 'project');
        const hasTiles = selected.some(s => s.type === 'tile');

        if (hasProjects && hasTiles) {
            alert('Please select only projects or only tiles to copy, not both.');
            return;
        }

        if (hasProjects) {
            // Copy projects to another dashboard
            await showCopyProjectsDialog(selected.filter(s => s.type === 'project'));
        } else {
            // Copy tiles to another project
            await showCopyTilesDialog(selected.filter(s => s.type === 'tile'));
        }
    });

    // Helper: Show target selection modal
    function showTargetModal(title, options, onConfirm) {
        const modal = document.getElementById('bulk-target-modal');
        const titleEl = document.getElementById('bulk-target-title');
        const selectEl = document.getElementById('bulk-target-select');
        const cancelBtn = document.getElementById('bulk-target-cancel');
        const confirmBtn = document.getElementById('bulk-target-confirm');

        titleEl.textContent = title;
        selectEl.innerHTML = '';

        options.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.id;
            option.textContent = opt.name;
            selectEl.appendChild(option);
        });

        confirmBtn.classList.add('enabled');
        confirmBtn.disabled = false;
        modal.style.display = 'flex';

        // Use one-time event handlers
        const handleCancel = () => {
            modal.style.display = 'none';
            cancelBtn.removeEventListener('click', handleCancel);
            confirmBtn.removeEventListener('click', handleConfirm);
        };

        const handleConfirm = () => {
            const selectedId = selectEl.value;
            const selected = options.find(o => o.id === selectedId);
            modal.style.display = 'none';
            cancelBtn.removeEventListener('click', handleCancel);
            confirmBtn.removeEventListener('click', handleConfirm);
            if (selected) onConfirm(selected);
        };

        cancelBtn.addEventListener('click', handleCancel);
        confirmBtn.addEventListener('click', handleConfirm);
    }

    // Helper: Show move projects dialog
    async function showMoveProjectsDialog(projects) {
        let dashboards = await db.dashboards.toArray();
        dashboards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        const currentDashboardId = window.currentDashboardId;
        const otherDashboards = dashboards.filter(d => d.id !== currentDashboardId);

        if (otherDashboards.length === 0) {
            alert('No other spaces available. Create another space first.');
            return;
        }

        showTargetModal('Move to Space', otherDashboards, async (targetDashboard) => {
            // Get max order in target dashboard
            const existingProjects = await db.projects.where('dashboardId').equals(targetDashboard.id).toArray();

            let maxOrder = -1;
            existingProjects.forEach(p => {
                const order = Number.isFinite(+p.order) ? +p.order : -1;
                if (order > maxOrder) maxOrder = order;
            });
            let nextOrder = maxOrder + 1;

            // Update each project's dashboardId and order
            for (const proj of projects) {
                await db.projects.update(proj.id, {
                    dashboardId: targetDashboard.id,
                    order: nextOrder++
                });
            }

            // Remove elements from DOM after all DB updates complete
            projects.forEach(p => p.element?.remove());
            exitBulkMode();
            showStatus(`Moved ${projects.length} project${projects.length > 1 ? 's' : ''} to ${targetDashboard.name}`);
        });
    }

    // Helper: Show tree modal for selecting a project (across all dashboards)
    async function showTreeTargetModal(title, onConfirm) {
        const modal = document.getElementById('bulk-tile-target-modal');
        const titleEl = document.getElementById('bulk-tile-target-title');
        const treeEl = document.getElementById('bulk-tile-target-tree');
        const cancelBtn = document.getElementById('bulk-tile-target-cancel');
        const confirmBtn = document.getElementById('bulk-tile-target-confirm');

        titleEl.textContent = title;
        treeEl.innerHTML = '';
        confirmBtn.disabled = true;
        confirmBtn.classList.remove('enabled');
        
        // Get all dashboards and projects
        let dashboards = await db.dashboards.toArray();
        dashboards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        let allProjects = await db.projects.toArray();

        let selectedProject = null;
        let pendingCreateProject = null; // Reference to active createProject function

        // Build tree
        for (const dashboard of dashboards) {
            const dashProjects = allProjects
                .filter(p => p.dashboardId === dashboard.id)
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

            const dashEl = document.createElement('div');
            dashEl.className = 'target-tree-dashboard collapsed';

            const headerEl = document.createElement('div');
            headerEl.className = 'target-tree-dashboard-header';
            headerEl.innerHTML = `
                <svg class="target-tree-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
                <svg class="target-tree-dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="7" height="7"></rect>
                    <rect x="14" y="3" width="7" height="7"></rect>
                    <rect x="14" y="14" width="7" height="7"></rect>
                    <rect x="3" y="14" width="7" height="7"></rect>
                </svg>
                <span class="target-tree-dashboard-name">${escapeHtml(dashboard.name)}</span>
            `;
            headerEl.addEventListener('click', () => {
                dashEl.classList.toggle('collapsed');
            });

            const projectsEl = document.createElement('div');
            projectsEl.className = 'target-tree-projects';

            for (const project of dashProjects) {
                const projEl = document.createElement('div');
                projEl.className = 'target-tree-project';
                projEl.dataset.projectId = project.id;

                // Use different icon for unsorted projects
                if (project.isUnassigned) {
                    projEl.innerHTML = `
                        <svg class="target-tree-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
                            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
                        </svg>
                        <span>Unsorted</span>
                    `;
                } else {
                    projEl.innerHTML = `
                        <svg class="target-tree-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        <span>${escapeHtml(project.name)}</span>
                    `;
                }
                projEl.addEventListener('click', () => {
                    // Deselect previous
                    treeEl.querySelectorAll('.target-tree-project.selected').forEach(el => {
                        el.classList.remove('selected');
                    });
                    // Select this one
                    projEl.classList.add('selected');
                    selectedProject = project;
                    confirmBtn.disabled = false;
                    confirmBtn.classList.add('enabled');
                                    });
                projectsEl.appendChild(projEl);
            }

            // Add "+ New Project" option
            const newProjEl = document.createElement('div');
            newProjEl.className = 'target-tree-new-project';
            newProjEl.innerHTML = `
                <svg class="target-tree-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                <span>New Project</span>
            `;
            newProjEl.addEventListener('click', async (e) => {
                e.stopPropagation();
                // Replace with input field
                newProjEl.innerHTML = `
                    <input type="text" class="target-tree-new-project-input" placeholder="Project name..." autofocus>
                `;
                const input = newProjEl.querySelector('input');
                input.focus();

                // Enable/disable confirm button as user types
                input.addEventListener('input', () => {
                    if (input.value.trim()) {
                        confirmBtn.disabled = false;
                        confirmBtn.classList.add('enabled');
                                            } else {
                        confirmBtn.disabled = true;
                        confirmBtn.classList.remove('enabled');
                                            }
                });

                let isCreating = false;
                const createProject = async () => {
                    pendingCreateProject = null; // Clear reference when creating
                    if (isCreating) return;
                    const name = input.value.trim();
                    if (!name) {
                        // Reset to button state
                        newProjEl.innerHTML = `
                            <svg class="target-tree-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="12" y1="5" x2="12" y2="19"/>
                                <line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            <span>New Project</span>
                        `;
                        return;
                    }

                    isCreating = true;

                    // Get max order for this dashboard
                    const dashProjects = allProjects.filter(p => p.dashboardId === dashboard.id);
                    let maxOrder = -1;
                    dashProjects.forEach(p => {
                        const order = Number.isFinite(+p.order) ? +p.order : -1;
                        if (order > maxOrder) maxOrder = order;
                    });

                    // Create new project
                    const newProject = {
                        id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
                        name: name,
                        dashboardId: dashboard.id,
                        order: maxOrder + 1
                    };

                    // Enable confirm button immediately
                    selectedProject = newProject;
                    confirmBtn.disabled = false;
                    confirmBtn.classList.add('enabled');
                    // Force visual update
                    
                    await db.projects.add(newProject);

                    // Add to allProjects for future reference
                    allProjects.push(newProject);

                    // Create project element and insert before "+ New Project"
                    const projEl = document.createElement('div');
                    projEl.className = 'target-tree-project selected';
                    projEl.dataset.projectId = newProject.id;
                    projEl.innerHTML = `
                        <svg class="target-tree-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        <span>${escapeHtml(newProject.name)}</span>
                    `;
                    projEl.addEventListener('click', () => {
                        treeEl.querySelectorAll('.target-tree-project.selected').forEach(el => {
                            el.classList.remove('selected');
                        });
                        projEl.classList.add('selected');
                        selectedProject = newProject;
                        confirmBtn.disabled = false;
                        confirmBtn.classList.add('enabled');
                                            });

                    // Deselect others and select this one
                    treeEl.querySelectorAll('.target-tree-project.selected').forEach(el => {
                        el.classList.remove('selected');
                    });
                    projectsEl.insertBefore(projEl, newProjEl);
                    selectedProject = newProject;
                    confirmBtn.disabled = false;
                    confirmBtn.classList.add('enabled');
                    
                    // Reset new project button
                    newProjEl.innerHTML = `
                        <svg class="target-tree-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="12" y1="5" x2="12" y2="19"/>
                            <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        <span>New Project</span>
                    `;
                };

                // Store reference so confirm button can trigger it
                pendingCreateProject = createProject;

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        createProject();
                    } else if (e.key === 'Escape') {
                        pendingCreateProject = null;
                        confirmBtn.disabled = true;
                        confirmBtn.classList.remove('enabled');
                                                newProjEl.innerHTML = `
                            <svg class="target-tree-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="12" y1="5" x2="12" y2="19"/>
                                <line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            <span>New Project</span>
                        `;
                    }
                });

                input.addEventListener('blur', () => {
                    // Small delay to allow Enter key to fire first
                    setTimeout(() => {
                        if (newProjEl.contains(input)) {
                            createProject();
                        }
                    }, 100);
                });
            });
            projectsEl.appendChild(newProjEl);

            dashEl.appendChild(headerEl);
            dashEl.appendChild(projectsEl);
            treeEl.appendChild(dashEl);
        }

        modal.style.display = 'flex';

        // Event handlers
        const handleCancel = () => {
            modal.style.display = 'none';
            cancelBtn.removeEventListener('click', handleCancel);
            confirmBtn.removeEventListener('click', handleConfirm);
        };

        const handleConfirm = async () => {
            // If there's a pending project creation, trigger it first
            if (pendingCreateProject && !selectedProject) {
                await pendingCreateProject();
            }
            if (!selectedProject) return;
            modal.style.display = 'none';
            cancelBtn.removeEventListener('click', handleCancel);
            confirmBtn.removeEventListener('click', handleConfirm);
            onConfirm(selectedProject);
        };

        cancelBtn.addEventListener('click', handleCancel);
        confirmBtn.addEventListener('click', handleConfirm);
    }

    // Helper: Show move tiles dialog
    async function showMoveTilesDialog(tiles) {
        showTreeTargetModal('Move to', async (targetProject) => {
            // Get max order in target project to append at end
            const existingTiles = await db.tiles.where('projectId').equals(targetProject.id).toArray();
            let nextOrder = existingTiles.reduce((max, t) => Math.max(max, t.order ?? -1), -1) + 1;

            // Update each tile's projectId and order
            for (const tile of tiles) {
                await db.tiles.update(tile.id, { projectId: targetProject.id, order: nextOrder++ });
            }

            // Move tile elements to target container (only works if on same dashboard)
            const targetContainer = document.querySelector(`.project[data-project-id="${targetProject.id}"] .tiles-container`);
            if (targetContainer) {
                const addButton = targetContainer.querySelector('.add-tile-button');
                tiles.forEach(t => {
                    if (t.element && addButton) {
                        targetContainer.insertBefore(t.element, addButton);
                        t.element.classList.remove('bulk-selected');
                        const cb = t.element.querySelector('.bulk-checkbox');
                        if (cb) cb.checked = false;
                    }
                });
            } else {
                // Target is on different dashboard or newly created - remove tiles and refresh
                tiles.forEach(t => t.element?.remove());
                // Refresh to show newly created project if on same dashboard
                if (window.__lifetilesRefresh) {
                    await window.__lifetilesRefresh();
                }
            }
            // Update Quick Save count in case tiles were moved from/to Quick Save
            if (window.__updateQuickSaveCount) await window.__updateQuickSaveCount();
            exitBulkMode();
            showStatus(`Moved ${tiles.length} tile${tiles.length > 1 ? 's' : ''} to ${targetProject.name}`);
        });
    }

    // Helper: Show copy projects dialog
    async function showCopyProjectsDialog(projects) {
        let dashboards = await db.dashboards.toArray();
        dashboards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        showTargetModal('Copy to Space', dashboards, async (targetDashboard) => {
            // Get max order in target dashboard
            const existingProjects = await db.projects.where('dashboardId').equals(targetDashboard.id).toArray();

            let maxOrder = -1;
            existingProjects.forEach(p => {
                const order = Number.isFinite(+p.order) ? +p.order : -1;
                if (order > maxOrder) maxOrder = order;
            });
            let nextOrder = maxOrder + 1;

            for (const proj of projects) {
                const originalProject = await db.projects.get(proj.id);
                if (!originalProject) continue;

                const newProjectId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
                const newProject = {
                    ...originalProject,
                    id: newProjectId,
                    dashboardId: targetDashboard.id,
                    name: originalProject.name + ' (Copy)',
                    order: nextOrder++
                };

                await db.projects.add(newProject);

                const originalTiles = await db.tiles.where('projectId').equals(proj.id).toArray();
                for (const tile of originalTiles) {
                    await db.tiles.add({
                        ...tile,
                        id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
                        projectId: newProjectId
                    });
                }
            }

            // Refresh to show newly copied projects
            if (window.__lifetilesRefresh) {
                await window.__lifetilesRefresh();
            }
            exitBulkMode();
            showStatus(`Copied ${projects.length} project${projects.length > 1 ? 's' : ''} to ${targetDashboard.name}`);
        });
    }

    // =========================================================================
    // OPEN TABS PANEL
    // =========================================================================
    (function initTabsPanel() {
        const toggleBtn = document.getElementById('tabs-panel-toggle');
        const panel = document.getElementById('tabs-panel');
        const listEl = document.getElementById('tabs-panel-list');
        const countEl = document.getElementById('tabs-panel-count');
        const selectAllCb = document.getElementById('tabs-panel-select-all');
        const refreshBtn = document.getElementById('tabs-panel-refresh');
        const saveBar = document.getElementById('tabs-panel-save-bar');
        const selCountEl = document.getElementById('tabs-panel-sel-count');
        const saveBtn = document.getElementById('tabs-panel-save-btn');

        if (!toggleBtn || !panel) return;

        let panelOpen = false;
        let selectedTabs = new Map(); // tabId -> { id, title, url, favIconUrl }
        let autoRefreshTimer = null;
        let currentTabs = []; // Latest fetched tabs
        let draggedTab = null; // Tab object being dragged from panel

        // Toggle panel open/close
        toggleBtn.addEventListener('click', () => {
            panelOpen = !panelOpen;
            if (panelOpen) openPanel(); else closePanel();
        });

        function openPanel() {
            panelOpen = true;
            document.body.classList.add('tabs-panel-open');
            panel.classList.remove('hidden');
            toggleBtn.classList.add('active');
            selectedTabs.clear();
            refreshTabList();
            autoRefreshTimer = setInterval(refreshTabList, 3000);
        }

        function closePanel() {
            panelOpen = false;
            document.body.classList.remove('tabs-panel-open');
            panel.classList.add('hidden');
            toggleBtn.classList.remove('active');
            if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
            selectedTabs.clear();
            updateSaveBar();
        }

        // Escape key closes panel when no modal is open
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && panelOpen) {
                // Don't close if a modal is visible
                const openModal = document.querySelector('.modal[style*="display: flex"]');
                if (openModal) return;
                closePanel();
            }
        });

        // Refresh button
        refreshBtn.addEventListener('click', () => refreshTabList());

        // Select All
        selectAllCb.addEventListener('change', () => {
            if (selectAllCb.checked) {
                for (const tab of currentTabs) {
                    selectedTabs.set(tab.id, tab);
                }
            } else {
                selectedTabs.clear();
            }
            syncCheckboxes();
            updateSaveBar();
        });

        // Save button
        saveBtn.addEventListener('click', () => {
            if (selectedTabs.size === 0) return;
            const tabsToSave = Array.from(selectedTabs.values());

            showTreeTargetModal('Save Tabs to', async (targetProject) => {
                let count = 0;
                for (const tab of tabsToSave) {
                    const tileId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
                    await db.tiles.add({
                        id: tileId,
                        projectId: targetProject.id,
                        dashboardId: targetProject.dashboardId || null,
                        name: tab.title || tab.url,
                        url: tab.url,
                        order: Date.now(),
                        favicon: tab.favIconUrl || ''
                    });
                    count++;
                }

                // Notify other components
                try {
                    const bc = new BroadcastChannel('lifetiles');
                    bc.postMessage({ type: 'tiles-changed' });
                    bc.close();
                } catch (err) { /* ignore */ }

                // Refresh dashboard
                if (window.__lifetilesRefresh) {
                    await window.__lifetilesRefresh();
                }

                selectedTabs.clear();
                updateSaveBar();
                refreshTabList();
                showStatus(`Saved ${count} tab${count > 1 ? 's' : ''} to ${escapeHtml(targetProject.name)}`);
            });
        });

        async function refreshTabList() {
            if (!panelOpen) return;

            let tabs = [];
            try {
                tabs = await chrome.tabs.query({ currentWindow: true });
            } catch (err) {
                listEl.innerHTML = '<div class="tabs-panel-empty">Cannot access tabs</div>';
                return;
            }

            // Get current dashboard tab URL to filter it out
            const selfUrl = location.href;

            // Filter out internal URLs and the dashboard tab itself
            tabs = tabs.filter(t => {
                if (!t.url) return false;
                try {
                    const u = new URL(t.url);
                    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
                } catch { return false; }
                if (t.url === selfUrl) return false;
                return true;
            });

            currentTabs = tabs;
            countEl.textContent = tabs.length;

            // Get all saved tile URLs for "already saved" detection
            let savedUrls = new Set();
            try {
                const allTiles = await db.tiles.toArray();
                for (const tile of allTiles) {
                    if (tile.url) savedUrls.add(tile.url);
                }
            } catch { /* ignore */ }

            // Preserve selection — remove tabs that no longer exist
            const tabIds = new Set(tabs.map(t => t.id));
            for (const id of selectedTabs.keys()) {
                if (!tabIds.has(id)) selectedTabs.delete(id);
            }

            // Render
            listEl.innerHTML = '';
            if (tabs.length === 0) {
                listEl.innerHTML = '<div class="tabs-panel-empty">No open web tabs</div>';
                updateSelectAll();
                updateSaveBar();
                return;
            }

            for (const tab of tabs) {
                const isSaved = savedUrls.has(tab.url);
                const item = document.createElement('div');
                item.className = 'tabs-panel-item' + (isSaved ? ' saved' : '');
                item.dataset.tabId = tab.id;

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = selectedTabs.has(tab.id);
                cb.addEventListener('change', () => {
                    if (cb.checked) {
                        selectedTabs.set(tab.id, tab);
                    } else {
                        selectedTabs.delete(tab.id);
                    }
                    updateSelectAll();
                    updateSaveBar();
                });

                const favicon = document.createElement('img');
                favicon.className = 'tabs-panel-item-favicon';
                favicon.src = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ddd"/></svg>';
                favicon.alt = '';
                favicon.loading = 'lazy';
                favicon.onerror = function() {
                    this.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ddd"/></svg>';
                };

                const title = document.createElement('span');
                title.className = 'tabs-panel-item-title';
                title.textContent = tab.title || tab.url;
                title.title = tab.url;

                item.appendChild(cb);
                item.appendChild(favicon);
                item.appendChild(title);

                if (isSaved) {
                    const badge = document.createElement('span');
                    badge.className = 'tabs-panel-saved-badge';
                    badge.textContent = 'saved';
                    item.appendChild(badge);
                }

                // Click on item row toggles checkbox
                item.addEventListener('click', (e) => {
                    if (e.target === cb) return; // checkbox handles itself
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                });

                // Drag support
                item.draggable = true;
                item.addEventListener('dragstart', (e) => {
                    draggedTab = tab;
                    item.classList.add('dragging');
                    document.body.classList.add('dragging', 'dragging-panel-tab');
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('text/plain', tab.url);
                });
                item.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                    document.body.classList.remove('dragging', 'dragging-panel-tab');
                    draggedTab = null;
                    // Clean up any lingering drop highlights
                    document.querySelectorAll('.tab-drop-target').forEach(el => el.classList.remove('tab-drop-target'));
                });

                listEl.appendChild(item);
            }

            updateSelectAll();
            updateSaveBar();
        }

        function syncCheckboxes() {
            const items = listEl.querySelectorAll('.tabs-panel-item input[type="checkbox"]');
            items.forEach(cb => {
                const tabId = parseInt(cb.closest('.tabs-panel-item').dataset.tabId, 10);
                cb.checked = selectedTabs.has(tabId);
            });
        }

        function updateSelectAll() {
            if (currentTabs.length === 0) {
                selectAllCb.checked = false;
                selectAllCb.indeterminate = false;
                return;
            }
            const allSelected = currentTabs.length > 0 && selectedTabs.size === currentTabs.length;
            const someSelected = selectedTabs.size > 0 && !allSelected;
            selectAllCb.checked = allSelected;
            selectAllCb.indeterminate = someSelected;
        }

        function updateSaveBar() {
            if (selectedTabs.size > 0) {
                saveBar.classList.remove('hidden');
                selCountEl.textContent = `${selectedTabs.size} selected`;
            } else {
                saveBar.classList.add('hidden');
            }
        }

        // --- Drag-to-project drop targets (event delegation on #main) ---
        const mainEl = document.getElementById('main');
        if (mainEl) {
            mainEl.addEventListener('dragover', (e) => {
                if (!draggedTab) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                const target = e.target.closest('.project, .unassigned-section');
                // Remove highlight from all, then add to current target
                document.querySelectorAll('.tab-drop-target').forEach(el => {
                    if (el !== target) el.classList.remove('tab-drop-target');
                });
                if (target) target.classList.add('tab-drop-target');
            });

            mainEl.addEventListener('dragleave', (e) => {
                if (!draggedTab) return;
                const target = e.target.closest('.project, .unassigned-section');
                if (target && !target.contains(e.relatedTarget)) {
                    target.classList.remove('tab-drop-target');
                }
            });

            mainEl.addEventListener('drop', async (e) => {
                if (!draggedTab) return;
                e.preventDefault();
                const target = e.target.closest('.project, .unassigned-section');
                document.querySelectorAll('.tab-drop-target').forEach(el => el.classList.remove('tab-drop-target'));
                if (!target) return;

                const projectId = target.dataset.projectId;
                if (!projectId) return;

                const tab = draggedTab;
                draggedTab = null;

                // Look up project to get dashboardId
                let dashboardId = null;
                try {
                    const proj = await db.projects.get(projectId);
                    if (proj) dashboardId = proj.dashboardId || null;
                } catch { /* ignore */ }

                const tileId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
                await db.tiles.add({
                    id: tileId,
                    projectId: projectId,
                    dashboardId: dashboardId,
                    name: tab.title || tab.url,
                    url: tab.url,
                    order: Date.now(),
                    favicon: tab.favIconUrl || ''
                });

                // Notify other components
                try {
                    const bc = new BroadcastChannel('lifetiles');
                    bc.postMessage({ type: 'tiles-changed' });
                    bc.close();
                } catch (err) { /* ignore */ }

                // Refresh dashboard and panel
                if (window.__lifetilesRefresh) {
                    await window.__lifetilesRefresh();
                }
                refreshTabList();

                // Get project name for status message
                let projectName = 'project';
                try {
                    const proj = await db.projects.get(projectId);
                    if (proj) projectName = proj.name || (proj.isUnassigned ? 'Unsorted' : 'project');
                } catch { /* ignore */ }
                showStatus(`Saved tab to ${escapeHtml(projectName)}`);
            });
        }
    })();

    // Helper: Show copy tiles dialog
    async function showCopyTilesDialog(tiles) {
        showTreeTargetModal('Copy to', async (targetProject) => {
            const newTiles = [];
            for (const tile of tiles) {
                const originalTile = await db.tiles.get(tile.id);

                if (originalTile) {
                    const newTile = {
                        ...originalTile,
                        id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
                        projectId: targetProject.id
                    };
                    await db.tiles.add(newTile);
                    newTiles.push(newTile);
                }
            }

            // Add tile elements if target is on current dashboard
            const targetContainer = document.querySelector(`.project[data-project-id="${targetProject.id}"] .tiles-container`);
            if (targetContainer) {
                for (const tileData of newTiles) {
                    await createTileElement(targetContainer, tileData);
                }
            } else {
                // Target project might be newly created - refresh to show it
                if (window.__lifetilesRefresh) {
                    await window.__lifetilesRefresh();
                }
            }
            exitBulkMode();
            showStatus(`Copied ${tiles.length} tile${tiles.length > 1 ? 's' : ''} to ${targetProject.name}`);
        });
    }
})();
