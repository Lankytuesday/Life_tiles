const __ltOnsiteBlocked = new Set();

let lifetilesBC = null;

// Helper to trigger sync after data mutations
function triggerSync() {
    if (typeof LifetilesSync !== 'undefined') {
        LifetilesSync.scheduleSync();
    }
}

let __ltRefreshScheduled = false;

function __ltScheduleRefresh() {
  if (__ltRefreshScheduled) return;
  __ltRefreshScheduled = true;
  setTimeout(() => {
    __ltRefreshScheduled = false;
    window.__lifetilesRefresh?.();
  }, 50);
}

// Favicons cache TTL (24h). Set to 6h if you prefer faster refreshes.
const FAVICON_TTL_MS = 86400000;
// Probe an image URL to verify it actually loads (no fetch → no ORB)
async function probeImage(src, timeout = 900) {
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const finish = ok => { if (done) return; done = true; resolve(ok); };
      const t = setTimeout(() => finish(false), timeout);
      img.onload = () => { clearTimeout(t); finish(img.naturalWidth > 0 && img.naturalHeight > 0); };
      img.onerror = () => { clearTimeout(t); finish(false); };
      img.referrerPolicy = 'no-referrer';
      img.src = src;
    });
  }
// One-time cleanup: remove legacy cached favicons that point to deprecated services
async function purgeLegacyFavicons() {
    try {
      const db = await initDB();
      const tx = db.transaction(['favicons'], 'readwrite');
      const store = tx.objectStore('favicons');

      const rows = await new Promise((res, rej) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => rej(req.error);
      });

      for (const row of rows) {
        const f = row?.favicon || '';
        if (typeof f === 'string' && (
          // Match old Google favicon services
          /(?:^|\/\/)t\d*\.gstatic\.com\/favicon/i.test(f) ||
          /(?:^|\/\/)www\.google\.com\/s2\/favicons.*sz=16/i.test(f) ||
          // Match any deprecated favicon services
          /favicon.*googleapis/i.test(f)
        )) {
          store.delete(row.hostname);
          sessionFaviconCache.delete?.(row.hostname);
          console.log('Purged deprecated favicon cache for:', row.hostname);
        }
      }
    } catch {}
  }
purgeLegacyFavicons(); // fire-and-forget migration

// Per-page in-memory cache to avoid duplicate probes
const sessionFaviconCache = new Map();

// First: tab-based probe (needs "tabs" permission in manifest)
async function tryTabFavicon(pageUrl, min = 3) {
    try {
      if (!chrome?.tabs?.query || !pageUrl) return null;
  
      const wanted = new URL(pageUrl);
      const wantedHost = wanted.hostname;
  
      // Query all tabs (avoids needing host_permissions for url filtering)
      const tabs = await chrome.tabs.query({});
      // Prefer exact URL match, then same-host match
      let u = null;
      const exact = tabs.find(t => {
        try { return new URL(t.url).href === wanted.href; } catch { return false; }
      });
      if (exact?.favIconUrl) u = exact.favIconUrl;
      if (!u) {
        const sameHost = tabs.find(t => {
          try { return new URL(t.url).hostname === wantedHost; } catch { return false; }
        });
        if (sameHost?.favIconUrl) u = sameHost.favIconUrl;
      }
      if (!u) return null;
  
      // Size-check via your img probe
      return await tryImgWithMinSize(u, min);
    } catch {
      return null;
    }
  }
// Probe a favicon by actually loading it as <img> (avoids ORB/CORB)
async function loadFaviconForHost(hostname, pageUrl) {
    if (sessionFaviconCache.has(hostname)) {
      return sessionFaviconCache.get(hostname);
    }
  
    // --- size preferences ---
    const MIN_FAVICON_PX = 16;   // allow legit 16px icons
    const PREF_FAVICON_PX = 24;  // prefer ≥24px when available
    const S2_MIN_PX      = 24;   // S2 must be ≥24px (blocks 16px globe)
  
    // Normalize page URL (for tab-favicon path)
    let normalizedPageUrl = null;
    if (typeof pageUrl === "string") {
      try { normalizedPageUrl = new URL(pageUrl).href; } catch {}
    }
    if (!normalizedPageUrl && hostname) {
      normalizedPageUrl = `https://${hostname}`;
    }
  
    // Detect the pixelated S2 globe
    function isLikelyPlaceholder(url = "", w = 0, h = 0) {
      const isS2 = /(?:^|\/\/)www\.google\.com\/s2\/favicons/i.test(url);
      const tiny = Math.max(w, h) <= 16;
      return isS2 && tiny;
    }
  
    // Helper: apex vs subdomain
    const isApexHost = (h) => (h || "").split(".").filter(Boolean).length === 2;
  
    // Host variants for **onsite/icon.horse** (no eTLD+1 expansion here)
    function buildSiteVariants(host) {
      if (!host) return [];
      const parts = host.split(".").filter(Boolean);
      const set = new Set([host]);
      if (parts[0] === "www") set.add(parts.slice(1).join("."));
      else if (parts.length === 2) set.add(`www.${host}`);
      return Array.from(set);
    }
  
    // eTLD+1 for S2 fallback (e.g., news.kvue.com → kvue.com)
    function etld1(host) {
      const parts = (host || "").split(".").filter(Boolean);
      return parts.length >= 2 ? parts.slice(-2).join(".") : host;
    }
  
    // Generic probe with min-size filter + globe reject + 900ms timeout
    // Also: if a site URL fails *very fast*, mark host as "onsite blocked"
    const tryImgWithMinSize = (url, min = MIN_FAVICON_PX, timeoutMs = 900) =>
      new Promise((resolve) => {
        const img = new Image();
        let finished = false;
        const t0 = performance.now();
        const done = (val) => { if (!finished) { finished = true; resolve(val); } };
        const timer = setTimeout(() => done(null), timeoutMs);
  
        img.onload = () => {
          clearTimeout(timer);
          const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
          if (isLikelyPlaceholder(url, w, h)) return done(null); // 🚫 block S2 globe
          done((w >= min && h >= min) ? url : null);
        };
        img.onerror = () => {
          clearTimeout(timer);
          const dt = performance.now() - t0;
          // Fast fail on same-origin site path → likely 403/cert block → remember
          if (dt < 150 && hostname && url.startsWith(`https://${hostname}/`)) {
            __ltOnsiteBlocked.add(hostname);
          }
          done(null);
        };
        img.referrerPolicy = "no-referrer";
        img.src = url;
      });
  
    const siteVariants = buildSiteVariants(hostname);
    let found = null;
  
    // 0) Tab favicon first (prefer ≥24px, then allow 16px)
    if (typeof tryTabFavicon === "function" && normalizedPageUrl) {
      found = await tryTabFavicon(normalizedPageUrl, PREF_FAVICON_PX);
      if (!found) found = await tryTabFavicon(normalizedPageUrl, MIN_FAVICON_PX);
    }
  
    // ===== SUBDOMAINS: services → onsite (lean) =====
    if (!found && hostname && !isApexHost(hostname)) {
      // Services first: S2 (≥24) then icon.horse (24, then 16)
      if (!found) {
        const s2Hosts = Array.from(new Set([hostname, etld1(hostname)])).filter(Boolean);
        for (const h of s2Hosts) {
          const s2 = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(h)}`;
          const hit = await tryImgWithMinSize(s2, S2_MIN_PX);
          if (hit) { found = hit; break; }
        }
      }
      if (!found) {
        for (const h of siteVariants) {
          found = await tryImgWithMinSize(`https://icon.horse/icon/${h}`, PREF_FAVICON_PX)
               || await tryImgWithMinSize(`https://icon.horse/icon/${h}`, MIN_FAVICON_PX);
          if (found) break;
        }
      }
      // Onsite last (only if not flagged as blocked)
      if (!found && !__ltOnsiteBlocked.has(hostname)) {
        for (const h of siteVariants) {
          const candidates = [
            `https://${h}/favicon.ico`,
            `https://${h}/favicon.svg`,
          ];
          for (const u of candidates) {
            found = await tryImgWithMinSize(u, PREF_FAVICON_PX);
            if (found) break;
          }
          if (!found) {
            for (const u of candidates) {
              found = await tryImgWithMinSize(u, MIN_FAVICON_PX);
              if (found) break;
            }
          }
          if (found) break;
        }
      }
    }
  
    // ===== APEX: onsite (rich) → services =====
    if (!found && hostname && isApexHost(hostname)) {
      // Onsite first (unless previously flagged)
      if (!__ltOnsiteBlocked.has(hostname)) {
        for (const h of siteVariants) {
          const candidates = [
            `https://${h}/favicon.svg`,
            `https://${h}/apple-touch-icon.png`,
            `https://${h}/favicon.ico`,
            `https://${h}/favicon-32x32.png`,
          ];
          for (const u of candidates) {
            found = await tryImgWithMinSize(u, PREF_FAVICON_PX);
            if (found) break;
          }
          if (!found) {
            for (const u of candidates) {
              found = await tryImgWithMinSize(u, MIN_FAVICON_PX);
              if (found) break;
            }
          }
          if (found) break;
        }
      }
      // Services next
      if (!found) {
        const s2Hosts = Array.from(new Set([hostname, etld1(hostname)])).filter(Boolean);
        for (const h of s2Hosts) {
          const s2 = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(h)}`;
          const hit = await tryImgWithMinSize(s2, S2_MIN_PX);
          if (hit) { found = hit; break; }
        }
        if (!found) {
          for (const h of siteVariants) {
            found = await tryImgWithMinSize(`https://icon.horse/icon/${h}`, PREF_FAVICON_PX)
                 || await tryImgWithMinSize(`https://icon.horse/icon/${h}`, MIN_FAVICON_PX);
            if (found) break;
          }
        }
      }
    }
  
    // Cache for this session
    sessionFaviconCache.set(hostname, found || "");
  
    // Persist if found
    if (found) {
      try {
        const db = await initDB();
        const tx = db.transaction(["favicons"], "readwrite");
        tx.objectStore("favicons").put({ hostname, favicon: found, timestamp: Date.now() });
      } catch {}
    }
  
    return found;
  }
  
  

// --- internal URL helpers ---
const INTERNAL_SCHEME_RE = /^(?:chrome:|chrome-extension:|devtools:|edge:|brave:|opera:|vivaldi:|about:|chrome-search:|moz-extension:|file:)$/i;
function isInternalUrl(u) {
  try { return INTERNAL_SCHEME_RE.test(new URL(u).protocol); }
  catch { return true; } // invalid/blank -> treat as internal
}





// Initialize favicon cache handling
async function checkFaviconCache(hostname) {
    try {
        const db = await initDB();
        const tx = db.transaction(['favicons'], 'readonly');
        const store = tx.objectStore('favicons');
        const result = await new Promise((resolve, reject) => {
            const request = store.get(hostname);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        return (result?.favicon && result.timestamp > Date.now() - FAVICON_TTL_MS) ? result.favicon : null;
    } catch (e) {
        console.error('Error checking favicon cache:', e);
        return null;
    }
}

async function saveFaviconToCache(hostname, faviconUrl) {
    try {
        const db = await initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['favicons'], 'readwrite');
            const store = tx.objectStore('favicons');
            const request = store.put({
                hostname,
                favicon: faviconUrl,
                timestamp: Date.now()
            });

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.error('Error saving favicon to cache:', e);
    }
}

// Mock chrome.storage for development
if (typeof chrome === 'undefined' || !chrome.storage) {
    console.log('Chrome API not available, using mock storage for development');

    // Mock IndexedDB if not available
    if (!window.indexedDB) {
        window.indexedDB = window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    }
}
/*
async function migrateFromChromeStorage() {
    try {
        // Get all data from chrome.storage.sync
        const data = await new Promise(resolve => {
            chrome.storage.sync.get(null, resolve);
        });

        console.log('Retrieved storage data:', data);

        // Check if we have any projects to migrate
        const projectKeys = Object.keys(data).filter(key => key.startsWith('project_'));
        if (projectKeys.length === 0) {
            console.log('No projects found in storage');
            return false;
        }

        const db = await initDB();
        const tx = db.transaction(['dashboards', 'projects', 'tiles'], 'readwrite');

        // Store object stores in variables
        const dashboardStore = tx.objectStore('dashboards');
        const projectStore = tx.objectStore('projects');
        const tileStore = tx.objectStore('tiles');

        // Create default dashboard if none exists
        const defaultDashboard = {
            id: Date.now().toString(),
            name: "Imported Dashboard"
        };
        await dashboardStore.put(defaultDashboard);

        // Process projects and tiles
        for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('project_')) {
                // Add project
                const project = {
                    id: value.id || key.replace('project_', ''),
                    name: value.name || 'Imported Project',
                    dashboardId: defaultDashboard.id
                };
                await projectStore.put(project);

                // Process associated tiles
                if (value.tiles) {
                    for (const tile of value.tiles) {
                        await tileStore.put({
                            id: tile.id || Date.now().toString(),
                            name: tile.name,
                            url: tile.url,
                            projectId: project.id,
                            dashboardId: defaultDashboard.id
                        });
                    }
                }
            }
        }

        console.log('Migration completed successfully');
        return true;
    } catch (error) {
        console.error('Migration failed:', error);
        return false;
    }
}
*/
// Wire popup→dashboard live updates (BroadcastChannel + runtime message)
function wireLiveUpdates() {
    // BroadcastChannel (kept alive via global var)
    try {
      lifetilesBC = new BroadcastChannel('lifetiles');
      lifetilesBC.onmessage = (e) => {
        if (e?.data?.type === 'tiles:changed') {
            __ltScheduleRefresh();
            triggerSync(); // Sync changes from popup
        }
      };
      window.addEventListener('unload', () => { try { lifetilesBC?.close(); } catch {} });
    } catch {}

    // Fallback: runtime message
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'tiles:changed') {
            __ltScheduleRefresh();
            triggerSync(); // Sync changes from popup
        }
      });
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
    
    // Initialize IndexedDB
    try {
        const db = await initDB();
        console.log('IndexedDB initialized successfully');

        // Initialize sync after IndexedDB is ready
        if (typeof LifetilesSync !== 'undefined') {
            const syncResult = await LifetilesSync.init();
            console.log('[Sync] Init result:', syncResult);
            LifetilesSync.startListening();

            // Listen for remote updates to refresh UI
            window.addEventListener('lifetiles-sync', (e) => {
                if (e.detail.type === 'remote_update' && e.detail.imported) {
                    console.log('[Sync] Remote update received, refreshing UI');
                    loadDashboards(); // Refresh sidebar and projects
                }
                if (e.detail.type === 'quota_warning') {
                    console.warn('[Sync] Quota warning:', e.detail.percentUsed + '% used');
                    alert(`⚠️ Sync storage is ${e.detail.percentUsed}% full.\n\nYou're approaching the 100 KB limit. Consider removing unused tiles or projects.`);
                }
                if (e.detail.type === 'quota_exceeded') {
                    console.error('[Sync] Quota exceeded!');
                    alert(`❌ Sync failed: Storage limit exceeded!\n\nYour data is safe locally, but won't sync to other devices until you free up space.\n\nTry removing unused dashboards, projects, or tiles.`);
                }
            });

            // Push on page unload to ensure changes are saved
            window.addEventListener('beforeunload', () => {
                LifetilesSync.forceSync();
            });

            // Periodic sync every 5 minutes while page is open
            setInterval(() => {
                console.log('[Sync] Periodic sync check...');
                LifetilesSync.scheduleSync();
            }, 5 * 60 * 1000);
        }
    } catch (error) {
        console.error('Failed to initialize IndexedDB:', error);
    }

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
            <div class="settings-section">
                <div class="settings-section-label">Sync</div>
                <div id="sync-status" class="sync-status">Checking...</div>
                <div class="sync-quota-bar">
                    <div id="sync-quota-fill" class="sync-quota-fill"></div>
                </div>
                <div id="sync-quota-text" class="sync-quota-text"></div>
                <button type="button" data-action="sync-now">Sync now</button>
                <button type="button" data-action="sync-pull">Pull from cloud</button>
            </div>
            <div class="settings-divider"></div>
            <button type="button" data-action="import-google">Import Google bookmarks</button>
            <button type="button" data-action="export-dashboards">Export dashboards (JSON)</button>
            <button type="button" data-action="import-dashboards">Import dashboards (JSON)</button>
        `;
        settingsBtn.parentElement.appendChild(menu);

        // Update sync status when menu opens
        async function updateSyncStatus() {
            const statusEl = document.getElementById('sync-status');
            const quotaFill = document.getElementById('sync-quota-fill');
            const quotaText = document.getElementById('sync-quota-text');
            if (!statusEl) return;
            if (typeof LifetilesSync === 'undefined') {
                statusEl.textContent = 'Sync unavailable';
                statusEl.className = 'sync-status sync-error';
                return;
            }
            const status = await LifetilesSync.getStatus();
            if (status.enabled) {
                const lastSync = status.lastSynced
                    ? new Date(status.lastSynced).toLocaleTimeString()
                    : 'never';
                statusEl.textContent = `Last synced: ${lastSync}`;
                statusEl.className = 'sync-status sync-ok';

                // Update quota bar
                if (quotaFill && quotaText) {
                    const kb = (status.bytesUsed / 1024).toFixed(1);
                    const totalKb = (status.bytesTotal / 1024).toFixed(0);
                    quotaFill.style.width = `${status.percentUsed}%`;
                    quotaFill.className = `sync-quota-fill sync-quota-${status.quotaStatus}`;
                    quotaText.textContent = `${kb} KB / ${totalKb} KB (${status.percentUsed}%)`;
                    quotaText.className = `sync-quota-text sync-quota-${status.quotaStatus}`;
                }
            } else {
                statusEl.textContent = status.error || 'Sync disabled';
                statusEl.className = 'sync-status sync-error';
            }
        }

        // Toggle open/close
        function closeSettingsMenu() {
            settingsBtn.classList.remove('active');
            settingsBtn.setAttribute('aria-expanded', 'false');
        }
        function openSettingsMenu() {
            settingsBtn.classList.add('active');
            settingsBtn.setAttribute('aria-expanded', 'true');
            updateSyncStatus(); // Refresh sync status when menu opens
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
                if (action === 'sync-now') {
                    const statusEl = document.getElementById('sync-status');
                    if (statusEl) statusEl.textContent = 'Syncing...';
                    const result = await LifetilesSync.forceSync();
                    console.log('[Sync] Force sync result:', result);
                    await updateSyncStatus();
                    if (result.success) {
                        if (statusEl) statusEl.textContent = 'Pushed to cloud!';
                    }
                    return; // Don't close menu for sync actions
                } else if (action === 'sync-pull') {
                    const statusEl = document.getElementById('sync-status');
                    if (statusEl) statusEl.textContent = 'Pulling...';
                    const result = await LifetilesSync.pullFromSync();
                    console.log('[Sync] Pull result:', result);
                    if (result.imported) {
                        if (statusEl) statusEl.textContent = 'Pulled! Refreshing...';
                        await loadDashboards(); // Refresh sidebar and projects
                    } else {
                        if (statusEl) statusEl.textContent = 'No changes to pull';
                    }
                    await updateSyncStatus();
                    return; // Don't close menu for sync actions
                } else if (action === 'import-google') {
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
                if (action !== 'sync-now' && action !== 'sync-pull') {
                    closeSettingsMenu();
                }
            }
        });
    }


    let currentProjectContainer = null;
    let currentProjectId = null;
    let currentDashboardId = null;

    // Load dashboards and projects on startup
    loadDashboards().catch(error => {
        console.error('Error loading dashboards:', error);
    });

// Initialize project sorting
new Sortable(document.getElementById('projects-container'), {
    animation: 150,
    draggable: '.project',
    handle: '.project-drag-handle',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    onStart: function () {
      document.body.classList.add('dragging');
      document.body.style.cursor = 'grabbing';
    },
    onEnd: function (evt) {
      // ✅ Persist PROJECT order (not tiles)
      document.body.classList.remove('dragging');
      document.body.style.cursor = '';
      updateProjectOrder(evt);
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
            new URL(string);
            return true;
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
            const db = await initDB();

            // Get all dashboards
            let dashboards = await new Promise((resolve, reject) => {
                const dashboardStore = db.transaction(['dashboards'], 'readonly').objectStore('dashboards');
                const request = dashboardStore.getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });

            // Sort dashboards by order property
            if (dashboards && dashboards.length > 0) {
                const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
                dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));

            }

            if (!dashboards || dashboards.length === 0) {
                // Create a default dashboard row
                const defaultDashboard = {
                  id: (crypto?.randomUUID?.() || Date.now().toString()),
                  name: "My Dashboard",
                  order: 0
                };
              
                // ✅ Properly await the IndexedDB transaction
                await new Promise((resolve, reject) => {
                  const tx = db.transaction(['dashboards'], 'readwrite');
                  const store = tx.objectStore('dashboards');
                  store.add(defaultDashboard);
                  tx.oncomplete = resolve;
                  tx.onerror = () => reject(tx.error);
                });
              
                // Select it
                localStorage.setItem('currentDashboardId', defaultDashboard.id);
                currentDashboardId = defaultDashboard.id;
              
                // ✅ Paint the UI immediately (sidebar + empty projects area)
                renderSidebar([defaultDashboard], defaultDashboard.id);
              
                const projectsContainer = document.getElementById('projects-container');
                if (projectsContainer) {
                  projectsContainer.innerHTML = '';
                  const newProjectButton = document.createElement('button');
                  newProjectButton.id = 'new-project';
                  newProjectButton.className = 'new-project';
                  newProjectButton.textContent = 'New Project';
                  newProjectButton.addEventListener('click', function () {
                    projectModal.style.display = "flex";
                    projectNameInput.focus();
                  });
                  projectsContainer.appendChild(newProjectButton);
                }
              
                // Nothing else to load yet
                return [defaultDashboard];
              }
              
              

            const currentId = localStorage.getItem('currentDashboardId') || dashboards[0].id;

            // Validate that the current dashboard still exists
            const validCurrentId = dashboards.find(d => d.id === currentId) ? currentId : dashboards[0].id;
            if (validCurrentId !== currentId) {
                localStorage.setItem('currentDashboardId', validCurrentId);
                currentDashboardId = validCurrentId;
            }

            renderSidebar(dashboards, validCurrentId);

            // Clear existing projects before loading new ones to prevent duplication
            const projectsContainer = document.getElementById('projects-container');
            projectsContainer.innerHTML = '';

            // Add the New Project button
            const newProjectButton = document.createElement('button');
            newProjectButton.id = 'new-project';
            newProjectButton.className = 'new-project';
            newProjectButton.textContent = 'New Project';
            newProjectButton.addEventListener('click', function() {
                projectModal.style.display = "flex";
                projectNameInput.focus();
            });
            projectsContainer.appendChild(newProjectButton);

            // Load projects for current dashboard
            const tx2 = db.transaction(['projects', 'tiles'], 'readonly');
            const projectStore = tx2.objectStore('projects');
            const projects = await new Promise((resolve) => {
                const request = projectStore.index('dashboardId').getAll(validCurrentId);
                request.onsuccess = () => resolve(request.result || []);
            });

            // Load all tiles for the projects
            const tileStore = tx2.objectStore('tiles');
            for (const project of projects) {
                const tiles = await new Promise((resolve) => {
                    const request = tileStore.index('projectId').getAll(project.id);
                    request.onsuccess = () => resolve(request.result || []);
                });
                project.tiles = tiles;
            }

            loadProjects(projects);
            currentDashboardId = validCurrentId;
            
            return dashboards;
        } catch (error) {
            console.error('Error in loadDashboards:', error);
            return [];
        }
    }
// make the dashboard reload callable from outside this closure
window.__lifetilesRefresh = () => loadDashboards();

// Create sidebar item element
    function createSidebarItem(dashboard) {
        const li = document.createElement('li');
        li.className = 'sidebar-item';
        li.setAttribute('role', 'option');
        li.dataset.dashboardId = dashboard.id;
        li.innerHTML = `
            <span class="dot"></span>
            <span class="label">${dashboard.name}</span>
            <div class="actions">
                <button class="sidebar-item-btn edit-btn" title="Edit" aria-label="Edit dashboard">✎</button>
                <button class="sidebar-item-btn delete-btn" title="Delete" aria-label="Delete dashboard">×</button>
            </div>
        `;
        return li;
    }

    // Render sidebar with all dashboards
    function renderSidebar(dashboards, currentId) {
        const list = document.getElementById('sidebar-list');
        if (!list) return;
        
        list.innerHTML = '';
        
        // Sort dashboards by order
        const sortedDashboards = dashboards.slice().sort((a, b) => {
            const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
            const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
            return ao - bo || String(a.id).localeCompare(String(b.id));
        });
        
        sortedDashboards.forEach(dashboard => {
            const li = createSidebarItem(dashboard);
            li.setAttribute('aria-selected', String(dashboard.id === currentId));
            li.tabIndex = dashboard.id === currentId ? 0 : -1;
            
            // Click to select dashboard
            li.addEventListener('click', (e) => {
                if (e.target.closest('.actions')) return; // Don't select if clicking action buttons
                switchDashboard(dashboard.id);
            });
            
            // Edit button
            const editBtn = li.querySelector('.edit-btn');
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                editDashboardInline(dashboard, li);
            });
            
            // Delete button
            const deleteBtn = li.querySelector('.delete-btn');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteDashboardFromSidebar(dashboard.id);
            });
            
            list.appendChild(li);
        });

        // Optional: Make sidebar sortable for reordering
        if (window.Sortable && !list.__sortable) {
            list.__sortable = new Sortable(list, {
                animation: 150,
                onEnd: async () => {
                    const ids = [...list.querySelectorAll('.sidebar-item')].map(li => li.dataset.dashboardId);
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
        input.style.cssText = 'border:1px solid #ddd; border-radius:4px; padding:2px 6px; font-size:14px; width:100%;';
        
        // Replace label with input
        labelEl.style.display = 'none';
        actionsEl.style.display = 'none';
        listItem.insertBefore(input, actionsEl);
        input.focus();
        input.select();
        
        const finishEdit = async (save = false) => {
            const newName = input.value.trim();
            if (save && newName && newName !== dashboard.name) {
                try {
                    const db = await initDB();
                    const tx = db.transaction(['dashboards'], 'readwrite');
                    const store = tx.objectStore('dashboards');
                    
                    await new Promise((resolve, reject) => {
                        const request = store.get(dashboard.id);
                        request.onsuccess = () => {
                            const updated = request.result;
                            updated.name = newName;
                            const updateRequest = store.put(updated);
                            updateRequest.onsuccess = () => resolve();
                            updateRequest.onerror = () => reject(updateRequest.error);
                        };
                        request.onerror = () => reject(request.error);
                    });

                    labelEl.textContent = newName;
                    dashboard.name = newName;
                    triggerSync();
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
        const db = await initDB();
        const tx = db.transaction(['dashboards'], 'readonly');
        const store = tx.objectStore('dashboards');

        const dashboards = await new Promise((resolve) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
        });

        if (dashboards.length <= 1) {
            alert("Cannot delete the last dashboard");
            return;
        }

        if (confirm('Are you sure you want to delete this dashboard? All projects and tiles in it will be removed.')) {
            // Use existing deletion logic
            await deleteDashboardFromManage(dashboardId, null);

            // Refresh sidebar
            const updatedDashboards = await loadDashboards();
            triggerSync();
        }
    }

    // Update dashboard order from sidebar
    async function updateDashboardOrderFromSidebar(idsInNewOrder) {
        try {
            const db = await initDB();
            const tx = db.transaction(['dashboards'], 'readwrite');
            const store = tx.objectStore('dashboards');

            idsInNewOrder.forEach((id, idx) => {
                const getReq = store.get(id);
                getReq.onsuccess = () => {
                    const rec = getReq.result;
                    if (!rec) return;
                    rec.order = idx;
                    store.put(rec);
                };
            });

            await new Promise(res => tx.oncomplete = res);
            triggerSync();
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
            const db = await initDB();
            const tx = db.transaction(['dashboards'], 'readonly');
            const store = tx.objectStore('dashboards');
            return new Promise((resolve) => {
                const req = store.getAll();
                req.onsuccess = () => {
                    dashboardsCache = req.result || [];
                    resolve(dashboardsCache);
                };
                req.onerror = () => resolve([]);
            });
        }

        function getDashboardName(dashboardId) {
            const d = dashboardsCache.find(db => String(db.id) === String(dashboardId));
            return d?.name || 'Unknown';
        }

        async function searchAll(query) {
            if (!query || query.length < 2) return { dashboards: [], projects: [], tiles: [] };

            const q = query.toLowerCase();
            const db = await initDB();
            const tx = db.transaction(['dashboards', 'projects', 'tiles'], 'readonly');

            const dashboards = await new Promise((resolve) => {
                const req = tx.objectStore('dashboards').getAll();
                req.onsuccess = () => resolve((req.result || []).filter(d => d.name.toLowerCase().includes(q)));
                req.onerror = () => resolve([]);
            });

            const projects = await new Promise((resolve) => {
                const req = tx.objectStore('projects').getAll();
                req.onsuccess = () => resolve((req.result || []).filter(p => p.name.toLowerCase().includes(q)));
                req.onerror = () => resolve([]);
            });

            const tiles = await new Promise((resolve) => {
                const req = tx.objectStore('tiles').getAll();
                req.onsuccess = () => resolve((req.result || []).filter(t =>
                    t.name.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)
                ));
                req.onerror = () => resolve([]);
            });

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
                html += '<div class="search-result-group">Dashboards</div>';
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
        // Update active sidebar item
        document.querySelectorAll('.sidebar-item').forEach(item => {
            const isActive = item.dataset.dashboardId === dashboardId;
            item.setAttribute('aria-selected', String(isActive));
            item.tabIndex = isActive ? 0 : -1;
        });

        // Save current dashboard
        localStorage.setItem('currentDashboardId', dashboardId);
        currentDashboardId = dashboardId;

        

        // Clear projects
        document.getElementById('projects-container').innerHTML = '';

        // Add the New Project button again
        const newProjectButton = document.createElement('button');
        newProjectButton.id = 'new-project';
        newProjectButton.className = 'new-project';
        newProjectButton.textContent = 'New Project';
        newProjectButton.addEventListener('click', function() {
            projectModal.style.display = "flex";
            projectNameInput.focus();
        });
        document.getElementById('projects-container').appendChild(newProjectButton);

        // Load projects for selected dashboard
        await loadProjectsForDashboard(dashboardId);
    }

    async function loadProjects(projects = []) {
        if (projects && projects.length > 0) {
            // Sort projects by order before creating elements
            projects.sort((a, b) => {
                const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
                const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
                return ao - bo || String(a.id).localeCompare(String(b.id));
            });

            const db = await initDB();
            const tx = db.transaction(['tiles'], 'readonly');
            const tileStore = tx.objectStore('tiles');

            for (const projectData of projects) {
                // Load tiles for this project
                const tiles = await new Promise((resolve) => {
                    const request = tileStore.index('projectId').getAll(projectData.id);
                    request.onsuccess = () => {
                        const tiles = request.result || [];
                        // Sort tiles by order property
                        tiles.sort((a, b) => {
                            const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
                            const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
                            return ao - bo || String(a.id).localeCompare(String(b.id));
                        });
                        console.log(`Loaded ${tiles.length} tiles for project ${projectData.id}`);
                        resolve(tiles);
                    };
                    request.onerror = () => resolve([]);
                });

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
        return Promise.resolve();
    }

    async function loadProjectsForDashboard(dashboardId) {
        const db = await initDB();
        const tx = db.transaction(['projects'], 'readonly');
        const projectStore = tx.objectStore('projects');
        const projectIndex = projectStore.index('dashboardId');

        return new Promise((resolve) => {
            const request = projectIndex.getAll(dashboardId);
            request.onsuccess = () => {
                loadProjects(request.result);
                resolve();
            };
        });
    }

    async function saveProject(projectData) {
        const db = await initDB();
        const tx = db.transaction(['projects'], 'readwrite');
        const store = tx.objectStore('projects');

        projectData.dashboardId = currentDashboardId;

        return new Promise((resolve, reject) => {
            const request = store.add(projectData);
            request.onsuccess = () => {
                createProjectElement(projectData);
                triggerSync();
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async function saveTile(projectId, tileData) {
        console.log('[saveTile] called with:', projectId, tileData.name);
        const db = await initDB();
        const tx = db.transaction('tiles', 'readwrite');
        const store = tx.objectStore('tiles');

        // Save full tile data in IndexedDB
        return new Promise((resolve, reject) => {
            const request = store.put({
                id: tileData.id,
                name: tileData.name,
                url: tileData.url,
                projectId: projectId,
                dashboardId: currentDashboardId,
                // ✅ keep the order assigned at creation (existingTiles.length)
                order: Number.isFinite(+tileData.order) ? +tileData.order : 0
            });
            request.onsuccess = () => {
                console.log('[saveTile] success, calling triggerSync');
                triggerSync();
                resolve();
            };
            request.onerror = () => reject(request.error);
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
        project.dataset.projectId = projectData.id;

        const projectHeader = document.createElement("div");
        projectHeader.className = "project-header";

        const dragHandle = document.createElement("div");
        dragHandle.className = "project-drag-handle";

        const projectTitle = document.createElement("h2");
        projectTitle.className = "project-title";
        projectTitle.textContent = projectData.name;

        const menuTrigger = document.createElement("button");
        menuTrigger.className = "project-menu-trigger";
        menuTrigger.innerHTML = "⋮";
        menuTrigger.addEventListener("click", (e) => {
            e.stopPropagation();
            closeAllMenus(); // Close any open menus first
            menuTrigger.classList.toggle("active");
        });

        const menu = document.createElement("div");
        menu.className = "project-menu";

            // Project edit button (refactored with fresh DB fetch)
        const editButton = document.createElement("button");
        editButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit`;
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

            const db = await initDB();
            const tx = db.transaction(['projects'], 'readwrite');
            const store = tx.objectStore('projects');
            const req = store.get(freshProject.id);

            req.onsuccess = () => {
                const updated = req.result;
                if (!updated) return;

                updated.name = newName;
                store.put(updated).onsuccess = () => {
                    const titleEl = currentProjectEl.querySelector('.project-title');
                    if (titleEl) titleEl.textContent = newName;

                    closeProjectModalHandler();
                    triggerSync();

                    // Reset the submit button back to "create" mode
                    const oldBtn = submitProjectBtn;
                    submitProjectBtn = oldBtn.cloneNode(true);
                    oldBtn.parentNode.replaceChild(submitProjectBtn, oldBtn);
                    submitProjectBtn.addEventListener('click', createNewProject);
                };
            };
        });
    };


    // Move to Dashboard button
    const moveButton = document.createElement("button");
    moveButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Move to Dashboard`;
    moveButton.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllMenus();

        const db = await initDB();
        let tx = db.transaction(['dashboards'], 'readonly');
        const dashboardStore = tx.objectStore('dashboards');

        let dashboards = await new Promise((resolve, reject) => {
            const request = dashboardStore.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

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
        title.textContent = 'Move to Dashboard';

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

            const db = await initDB();
            const tx = db.transaction(['projects', 'tiles'], 'readwrite');
            const projectStore = tx.objectStore('projects');
            const tileStore = tx.objectStore('tiles');

            // Get all tiles for this project
            const tiles = await new Promise((resolve) => {
                const request = tileStore.index('projectId').getAll(freshProject.id);
                request.onsuccess = () => resolve(request.result || []);
            });

            // Update project's dashboardId
            freshProject.dashboardId = selectedDashboardId;
            await new Promise((resolve, reject) => {
                const req = projectStore.put(freshProject);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });

            // Update all tiles' dashboardId
            for (const tile of tiles) {
                tile.dashboardId = selectedDashboardId;
                await new Promise((resolve, reject) => {
                    const req = tileStore.put(tile);
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(req.error);
                });
            }

            // Remove project from current view
            currentProjectEl.remove();
            modal.remove();
            triggerSync();
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
    copyButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy to Dashboard`;
    copyButton.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllMenus();

        const db = await initDB();
        let tx = db.transaction(['dashboards'], 'readonly'); // Only need dashboards for selection
        const dashboardStore = tx.objectStore('dashboards');

        // Get all dashboards
        let dashboards = await new Promise((resolve, reject) => {
            const request = dashboardStore.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

        // Sort dashboards by order property
        if (dashboards.length > 0) {
            const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
            dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));

        }

        // Create dashboard selection modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'flex';

        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.width = '280px';

        const title = document.createElement('h2');
        title.textContent = 'Select Dashboard';

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

            // 🔄 Always resolve the current project element
            const currentProjectEl = copyButton.closest('.project');
            if (!currentProjectEl) return;

            // 🔄 Fetch fresh project data
            const freshProject = await getProjectById(currentProjectEl.dataset.projectId);
            if (!freshProject) return;

            const db = await initDB();
            const tx = db.transaction(['projects', 'tiles'], 'readwrite');
            const projectStore = tx.objectStore('projects');
            const tileStore = tx.objectStore('tiles');

            // Get all tiles for this fresh project
            const tiles = await new Promise((resolve) => {
                const request = tileStore.index('projectId').getAll(freshProject.id);
                request.onsuccess = () => resolve(request.result || []);
            });

            // Build new project from FRESH data
            const newProjectData = {
                id: Date.now().toString(),
                name: freshProject.name,
                dashboardId: selectedDashboardId
            };

            // Add new project
            await projectStore.add(newProjectData);

            // Copy tiles to the new project
            for (const tile of tiles) {
                const newTile = {
                    ...tile,
                    id: Date.now().toString() + Math.random(),
                    projectId: newProjectData.id,
                    dashboardId: selectedDashboardId
                };
                await tileStore.add(newTile);
            }

            modal.remove();
            triggerSync();
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
                const db = await initDB();
                const tx = db.transaction(['projects'], 'readwrite');
                const store = tx.objectStore('projects');
                const request = store.delete(projectData.id);
                request.onsuccess = () => {
                    project.remove();
                    triggerSync();
                };
            }
        };

        menu.appendChild(editButton);
        menu.appendChild(moveButton);
        menu.appendChild(copyButton);
        menu.appendChild(removeButton);

        projectHeader.appendChild(dragHandle);
        projectHeader.appendChild(projectTitle);
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
                document.body.classList.add('dragging');
                // Disable all add buttons during drag
                document.querySelectorAll('.add-tile-button').forEach(btn => {
                    btn.classList.add('dragging-disabled');
                });

                // Ensure the dragged item has its tile ID
                const tileId = evt.item.dataset.tileId;
                if (!tileId) {
                    console.error('Dragged tile missing ID:', evt.item);
                } else {
                    console.log('Starting drag for tile:', tileId);
                }
            },
            onEnd: async function (evt) {
                // remove any drag state you set elsewhere
                document.body.classList.remove('dragging');

                // Re-enable all add buttons after drag
                requestAnimationFrame(() => {
                    document.querySelectorAll('.add-tile-button').forEach(btn => {
                        btn.classList.remove('dragging-disabled');
                        btn.classList.remove('hover');
                    });
                });

                // Move the add tile button to the end
                const addTileButton = evt.to.querySelector('.add-tile-button');
                if (addTileButton) {
                    evt.to.appendChild(addTileButton);
                }

                const db = await initDB();
                const tx = db.transaction(['tiles'], 'readwrite');
                const store = tx.objectStore('tiles');

                const resequence = (container) => {
                    if (!container) return;
                    const projEl = container.closest('.project');
                    if (!projEl) return;
                    const projectId = String(projEl.dataset.projectId);

                    // only real tiles; skip placeholders
                    const tileEls = [...container.querySelectorAll('.tile[data-tile-id]')];
                    tileEls.forEach((el, idx) => {
                        const tileId = el.dataset.tileId; // string id
                        const getReq = store.get(tileId);
                        getReq.onsuccess = () => {
                            const rec = getReq.result;
                            if (!rec) return;
                            rec.projectId = projectId;     // normalize container ownership
                            rec.order = idx;               // 0..N numeric
                            store.put(rec);
                        };
                    });
                };

                // handle same-project and cross-project moves
                resequence(evt.from);
                resequence(evt.to);

                // ✅ ensure all writes have actually committed before UI/broadcast
                await new Promise(res => tx.oncomplete = res);
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
        project.appendChild(tilesContainer);
        tilesContainer.appendChild(addTileButton);

        document.getElementById("projects-container").appendChild(project);
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
            // Get current tile count for proper order assignment
            const existingTiles = Array.from(currentProjectContainer.children)
                .filter(el => el.classList.contains('tile') && el.dataset.tileId);

            const tileData = {
                id: Date.now().toString(),
                name: tileName,
                url: tileUrl,
                projectId: currentProjectId,
                dashboardId: currentDashboardId,
                order: existingTiles.length
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
            // Get current tile count for proper order assignment
            const existingTiles = Array.from(currentProjectContainer.children)
                .filter(el => el.classList.contains('tile') && el.dataset.tileId);

            const tileData = {
                id: Date.now().toString(),
                name: tileName,
                url: tileUrl,
                projectId: currentProjectId,
                dashboardId: currentDashboardId,
                order: existingTiles.length
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
    async function getNextDashboardOrder(db) {
        const store = db.transaction(['dashboards'], 'readonly').objectStore('dashboards');
        const dashboards = await new Promise((res, rej) => {
          const req = store.getAll();
          req.onsuccess = () => res(req.result || []);
          req.onerror = () => rej(req.error);
        });
        const max = dashboards
          .map(d => Number.isFinite(+d.order) ? +d.order : -1)
          .reduce((a, b) => Math.max(a, b), -1);
        return max + 1;
      }
      
      // inside createNewDashboard()
      async function createNewDashboard() {
        const dashboardName = dashboardNameInput.value.trim();
        if (!dashboardName) return;
      
        const db = await initDB();
        const order = await getNextDashboardOrder(db);
      
        const dashboardData = {
          id: Date.now().toString(),
          name: dashboardName,
          projects: [],
          order
        };
      
        const tx = db.transaction(['dashboards'],'readwrite');
        tx.objectStore('dashboards').add(dashboardData);
        tx.oncomplete = async () => {
          // …your existing UI refresh code
          localStorage.setItem('currentDashboardId', dashboardData.id);
          currentDashboardId = dashboardData.id;
          await loadDashboards();
          closeDashboardModalHandler();
          triggerSync();
        };
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

        const outsideClose = (e) => {
            if (isMenuOrTrigger(e.target)) return; // clicked inside a menu or on its trigger
            closeAllMenus();                       // otherwise, close everything
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
            const db = await initDB();
            const tx = db.transaction(['dashboards', 'projects'], 'readonly');
            const dashboardStore = tx.objectStore('dashboards');
            const projectStore = tx.objectStore('projects');

            // Get all dashboards
            let dashboards = await new Promise((resolve, reject) => {
                const request = dashboardStore.getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });

            // Sort dashboards by order property
            if (dashboards && dashboards.length > 0) {
                const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
                dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));

            }

            // Get project counts for each dashboard
            for (const dashboard of dashboards) {
                const projects = await new Promise((resolve) => {
                    const request = projectStore.index('dashboardId').getAll(dashboard.id);
                    request.onsuccess = () => resolve(request.result || []);
                });
                dashboard.projectCount = projects.length;
            }

            // Sort dashboards by order (if available) or by name
            const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
            dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));


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
            alert('Error loading dashboards. Please try again.');
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

        // Check if trying to delete all dashboards
        const allDashboards = document.querySelectorAll('.dashboard-checkbox');
        if (selectedIds.length >= allDashboards.length) {
            alert("Cannot delete all dashboards. At least one dashboard must remain.");
            return;
        }

        // Check if current dashboard is being deleted
        const currentDashboardBeingDeleted = selectedIds.includes(currentDashboardId);

        if (confirm(`Are you sure you want to delete ${selectedIds.length} dashboard${selectedIds.length > 1 ? 's' : ''}? All projects and tiles in them will be removed.`)) {
            try {
                const db = await initDB();

                // If current dashboard is being deleted, switch to a remaining one first
                if (currentDashboardBeingDeleted) {
                    const remainingCheckboxes = Array.from(allDashboards).filter(cb => !selectedIds.includes(cb.dataset.dashboardId));
                    if (remainingCheckboxes.length > 0) {
                        const newCurrentId = remainingCheckboxes[0].dataset.dashboardId;
                        localStorage.setItem('currentDashboardId', newCurrentId);
                        currentDashboardId = newCurrentId;

                        // Clear projects container completely
                        const projectsContainer = document.getElementById('projects-container');
                        projectsContainer.innerHTML = '';
                        const newProjectButton = document.createElement('button');
                        newProjectButton.id = 'new-project';
                        newProjectButton.className = 'new-project';
                        newProjectButton.textContent = 'New Project';
                        newProjectButton.addEventListener('click', function() {
                            projectModal.style.display = "flex";
                            projectNameInput.focus();
                        });
                        projectsContainer.appendChild(newProjectButton);
                    }
                }

                // Delete each selected dashboard in a single transaction per dashboard
                for (const dashboardId of selectedIds) {
                    await new Promise(async (resolveDelete) => {
                        const tx = db.transaction(['dashboards', 'projects', 'tiles'], 'readwrite');
                        const dashboardStore = tx.objectStore('dashboards');
                        const projectStore = tx.objectStore('projects');
                        const tileStore = tx.objectStore('tiles');

                        // Delete all projects and tiles for this dashboard
                        const projects = await new Promise((resolve) => {
                            const request = projectStore.index('dashboardId').getAll(dashboardId);
                            request.onsuccess = () => resolve(request.result || []);
                        });

                        for (const project of projects) {
                            const tiles = await new Promise((resolve) => {
                                const request = tileStore.index('projectId').getAll(project.id);
                                request.onsuccess = () => resolve(request.result || []);
                            });

                            for (const tile of tiles) {
                                await new Promise((resolve) => {
                                    const request = tileStore.delete(tile.id);
                                    request.onsuccess = resolve;
                                });
                            }

                            // Delete the project
                            await new Promise((resolve) => {
                                const request = projectStore.delete(project.id);
                                request.onsuccess = resolve;
                            });
                        }

                        // Delete the dashboard
                        dashboardStore.delete(dashboardId);

                        tx.oncomplete = () => {
                            // Remove from UI immediately
                            const item = document.querySelector(`[data-dashboard-id="${dashboardId}"]`);
                            if (item) {
                                item.remove();
                            }
                            resolveDelete();
                        };

                        tx.onerror = () => {
                            console.error('Transaction failed for dashboard:', dashboardId);
                            resolveDelete();
                        };
                    });
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

                triggerSync();
            } catch (error) {
                console.error('Error bulk deleting dashboards:', error);
                alert('Error deleting dashboards. Please try again.');
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
                <div class="manage-dashboard-name">${dashboard.name}</div>
                <input type="text" class="manage-dashboard-name-input" value="${dashboard.name}">
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
            alert('Dashboard name cannot be empty');
            return;
        }

        try {
            const db = await initDB();
            const tx = db.transaction(['dashboards'], 'readwrite');
            const store = tx.objectStore('dashboards');

            await new Promise((resolve, reject) => {
                const request = store.get(dashboardId);
                request.onsuccess = () => {
                    const dashboard = request.result;
                    dashboard.name = newName;
                    const updateRequest = store.put(dashboard);
                    updateRequest.onsuccess = () => {
                        // Update the manage modal display
                        item.querySelector('.manage-dashboard-name').textContent = newName;
                        item.classList.remove('editing');

                        // Only update the dashboard selector without reloading projects
                        updateDashboardSelector().then(() => {
                            triggerSync();
                            resolve();
                        });
                    };
                    updateRequest.onerror = () => reject(updateRequest.error);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('Error saving dashboard name:', error);
            alert('Error saving dashboard name. Please try again.');
        }
    }

    async function deleteDashboardFromManage(dashboardId, item) {
        try {
            const db = await initDB();
            const tx = db.transaction(['dashboards'], 'readonly');
            const store = tx.objectStore('dashboards');

            const dashboards = await new Promise((resolve) => {
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result || []);
            });

            if (dashboards.length <= 1) {
                alert("Cannot delete the last dashboard");
                return;
            }

            if (confirm('Are you sure you want to delete this dashboard? All projects and tiles in it will be removed.')) {
                const tx2 = db.transaction(['dashboards', 'projects', 'tiles'], 'readwrite');
                const dashboardStore = tx2.objectStore('dashboards');
                const projectStore = tx2.objectStore('projects');
                const tileStore = tx2.objectStore('tiles');

                // Delete all projects and tiles for this dashboard
                const projects = await new Promise((resolve) => {
                    const request = projectStore.index('dashboardId').getAll(dashboardId);
                    request.onsuccess = () => resolve(request.result || []);
                });

                for (const project of projects) {
                    const tiles = await new Promise((resolve) => {
                        const request = tileStore.index('projectId').getAll(project.id);
                        request.onsuccess = () => resolve(request.result || []);
                    });

                    for (const tile of tiles) {
                        await new Promise((resolve) => {
                            const request = tileStore.delete(tile.id);
                            request.onsuccess = resolve;
                        });
                    }

                    await new Promise((resolve) => {
                        const request = projectStore.delete(project.id);
                        request.onsuccess = resolve;
                    });
                }

                // Delete the dashboard
                await new Promise((resolve) => {
                    const request = dashboardStore.delete(dashboardId);
                    request.onsuccess = resolve;
                });

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

                        // Clear projects container first
                        document.getElementById('projects-container').innerHTML = '';
                        const newProjectButton = document.createElement('button');
                        newProjectButton.id = 'new-project';
                        newProjectButton.className = 'new-project';
                        newProjectButton.textContent = 'New Project';
                        newProjectButton.addEventListener('click', function() {
                            projectModal.style.display = "flex";
                            projectNameInput.focus();
                        });
                        document.getElementById('projects-container').appendChild(newProjectButton);

                        // Only call loadDashboards to update the selector, it will load projects automatically
                        loadDashboards();
                    }
                } else {
                    // Just update the selector since we're not on the deleted dashboard
                    await updateDashboardSelector();
                }
                triggerSync();
            }
        } catch (error) {
            console.error('Error deleting dashboard:', error);
            alert('Error deleting dashboard. Please try again.');
        }
    }

    async function updateDashboardOrder(evt) {
        try {
            const db = await initDB();
            const tx = db.transaction(['dashboards'], 'readwrite');
            const store = tx.objectStore('dashboards');
            const items = Array.from(evt.to.children);

            // Update order for each dashboard item
            const promises = items.map(async (item, index) => {
                const dashboardId = item.dataset.dashboardId;
                return new Promise((resolve, reject) => {
                    const request = store.get(dashboardId);
                    request.onsuccess = () => {
                        const dashboard = request.result;
                        if (dashboard) {
                            dashboard.order = index;
                            const updateRequest = store.put(dashboard);
                            updateRequest.onsuccess = () => resolve();
                            updateRequest.onerror = () => reject(updateRequest.error);
                        } else {
                            resolve();
                        }
                    };
                    request.onerror = () => reject(request.error);
                });
            });

            // Wait for all updates to complete
            await Promise.all(promises);

            // Only update the dashboard selector without reloading projects
            await updateDashboardSelector();
            triggerSync();
        } catch (error) {
            console.error('Error updating dashboard order:', error);
        }
    }

    async function updateDashboardSelector() {
        try {
            const db = await initDB();

            // Get all dashboards
            let dashboards = await new Promise((resolve, reject) => {
                const dashboardStore = db.transaction(['dashboards'], 'readonly').objectStore('dashboards');
                const request = dashboardStore.getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

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
                    const db = await initDB();
                    const tx = db.transaction(['tiles'], 'readwrite');
                    const store = tx.objectStore('tiles');

                    await new Promise((resolve, reject) => {
                        const request = store.get(tileData.id);
                        request.onsuccess = () => {
                            const updatedTileData = request.result;
                            updatedTileData.name = newName;
                            updatedTileData.url = newUrl;
                            const updateRequest = store.put(updatedTileData);
                            updateRequest.onsuccess = () => resolve();
                            updateRequest.onerror = () => reject(updateRequest.error);
                        };
                        request.onerror = () => reject(request.error);
                    });

                    tile.querySelector('.tile-name').textContent = newName;
                    closeTileModalHandler();
                    triggerSync();

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
                const db = await initDB();
                const tx = db.transaction(['tiles'], 'readwrite');
                const store = tx.objectStore('tiles');
                const deleteRequest = store.delete(tileData.id);
                deleteRequest.onsuccess = () => {
                    tile.remove();
                    triggerSync();
                };
            }
        };

        menu.appendChild(editButton);
        menu.appendChild(removeButton);
        tile.appendChild(menuTrigger);
        tile.appendChild(menu);

        document.addEventListener("click", function(e) {
            if (!menu.contains(e.target) && e.target !== menuTrigger) {
                menuTrigger.classList.remove("active");
            }
        });

        tile.addEventListener("click", function(e) {
            if (!e.target.closest('.tile-menu') && !e.target.closest('.tile-menu-trigger')) {
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
            thumbnailElement.innerHTML = `<span class="tile-initials">${initials}</span>`;
        };

        // Show initials immediately as placeholder
        showInitials();

        const nameElement = document.createElement("div");
        nameElement.className = "tile-name";
        nameElement.textContent = truncateText(tileData.name, 60);
        nameElement.setAttribute("title", tileData.name);
        tile.setAttribute("title", tileData.name);

        tile.appendChild(thumbnailElement);
        tile.appendChild(nameElement);

        // 🔑 Insert NOW to preserve the sorted order
        const addTileButton = container.querySelector('.add-tile-button');
        container.insertBefore(tile, addTileButton);

        // Fetch favicon without blocking insertion (cache-first)
        (async () => {
            try {
            if (!safeHost) return;
        
            // 1) Try cache immediately (fast path, no network)
            let favicon = await checkFaviconCache(safeHost);
        
            // 2) If cache miss, do your normal discovery chain
            if (!favicon) {
                favicon = await loadFaviconForHost(safeHost, tileData.url);
            }
        
            // 3) Apply if we found one; otherwise initials remain
            if (favicon) {
                thumbnailElement.style.backgroundImage = `url('${favicon}')`;
                thumbnailElement.style.backgroundColor = 'transparent';
                thumbnailElement.innerHTML = '';
            }
            } catch {
            // keep initials fallback
            }
        })();
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
      const container = document.getElementById('projects-container');
      const projectEls = Array.from(container.querySelectorAll('.project')); // skips the "New Project" button
      const db = await initDB();
      const tx = db.transaction(['projects'], 'readwrite');
      const store = tx.objectStore('projects');

      await Promise.all(projectEls.map((el, index) => new Promise((resolve, reject) => {
        const id = el.dataset.projectId;
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const proj = getReq.result;
          if (!proj) return resolve();
          proj.order = index;
          const putReq = store.put(proj);
          putReq.onsuccess = resolve;
          putReq.onerror  = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      })));
      triggerSync();
    } catch (e) {
      console.error('updateProjectOrder failed:', e);
    }
  }
async function updateTileOrder(evt, fromProjectId, toProjectId) {
        try {
            const db = await initDB();

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
                await handleCrossProjectMove(db, draggedTileId, fromProjectId, toProjectId, evt);
            } else {
                // Handle same-project reorder
                await handleSameProjectReorder(db, toProjectId, evt);
            }

            // Remove hover states from all add-tile buttons after drag
            document.querySelectorAll('.add-tile-button').forEach(button => {
                button.classList.remove('hover');
            });

            triggerSync();
        } catch (error) {
            console.error('Error updating tile order:', error);
        }
    }

    async function handleCrossProjectMove(db, draggedTileId, fromProjectId, toProjectId, evt) {
        // First, update the dragged tile's project
        const tx1 = db.transaction(['tiles'], 'readwrite');
        const store1 = tx1.objectStore('tiles');

        await new Promise((resolve, reject) => {
            const getRequest = store1.get(draggedTileId);
            getRequest.onsuccess = () => {
                const tileData = getRequest.result;
                if (tileData) {
                    tileData.projectId = toProjectId;
                    tileData.dashboardId = currentDashboardId;
                    const putRequest = store1.put(tileData);
                    putRequest.onsuccess = () => resolve();
                    putRequest.onerror = () => reject(putRequest.error);
                } else {
                    reject(new Error('Tile not found: ' + draggedTileId));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });

        // Wait for transaction to complete
        await new Promise(resolve => {
            tx1.oncomplete = resolve;
        });

        // Then reorder both projects
        await handleSameProjectReorder(db, fromProjectId, { from: evt.from });
        await handleSameProjectReorder(db, toProjectId, { to: evt.to });
    }

    async function handleSameProjectReorder(db, projectId, evt) {
        const container = evt.to || evt.from;
        if (!container) return;

        const tileElements = Array.from(container.children).filter(
            el => el.classList.contains('tile') && el.dataset.tileId
        );
        if (!tileElements.length) return;

        const tx = db.transaction(['tiles'], 'readwrite');
        const store = tx.objectStore('tiles');

        const writes = tileElements.map((el, index) => {
            const tileId = el.dataset.tileId;
            return new Promise((resolve, reject) => {
                const getRequest = store.get(tileId);
                getRequest.onsuccess = () => {
                    const rec = getRequest.result;
                    if (!rec) return resolve(); // nothing to do for orphan
                    // ✅ Always normalize project + sequential order
                    rec.projectId = String(projectId);
                    rec.order = Number(index);
                    const put = store.put(rec);
                    put.onsuccess = () => resolve();
                    put.onerror  = () => reject(put.error);
                };
                getRequest.onerror = () => reject(getRequest.error);
            });
        });

        await Promise.all(writes);
        // ✅ make sure the transaction actually commits before we return
        await new Promise(res => { tx.oncomplete = res; });
    }



    async function getProjectTiles(projectId) {
        const db = await initDB();
        const tx = db.transaction(['tiles'], 'readonly');
        const tileStore = tx.objectStore('tiles');
        const tileIndex = tileStore.index('projectId');
        return new Promise((resolve) => {
            const request = tileIndex.getAll(projectId);
            request.onsuccess = () => resolve(request.result || []);
        });
    }
});

async function initDB() {
    return new Promise((resolve, reject) => {
        // Increment the version number to force an upgrade
        const request = indexedDB.open('lifetiles', 6);

        request.onerror = (event) => {
            reject(event.target.error);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Create or update stores
            if (!db.objectStoreNames.contains('dashboards')) {
                db.createObjectStore('dashboards', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('projects')) {
                const projectsStore = db.createObjectStore('projects', { keyPath: 'id' });
                projectsStore.createIndex('dashboardId', 'dashboardId', { unique: false });
            }
            if (!db.objectStoreNames.contains('tiles')) {
                const tilesStore = db.createObjectStore('tiles', { keyPath: 'id' });
                tilesStore.createIndex('projectId', 'projectId', { unique: false });
                tilesStore.createIndex('dashboardId', 'dashboardId', { unique: false });
            }
            if (!db.objectStoreNames.contains('favicons')) {
                db.createObjectStore('favicons', { keyPath: 'hostname' });
            }
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
    });
}
/*
async function migrateFromChromeStorage() {
    try {
        // Get all data from chrome.storage.sync
        const data = await new Promise(resolve => {
            chrome.storage.sync.get(null, resolve);
        });

        console.log('Retrieved storage data:', data);

        // Check if we have any projects to migrate
        const projectKeys = Object.keys(data).filter(key => key.startsWith('project_'));
        if (projectKeys.length === 0) {
            console.log('No projects found in storage');
            return false;
        }

        const db = await initDB();
        const tx = db.transaction(['dashboards', 'projects', 'tiles'], 'readwrite');

        // Store object stores in variables
        const dashboardStore = tx.objectStore('dashboards');
        const projectStore = tx.objectStore('projects');
        const tileStore = tx.objectStore('tiles');

        // Create default dashboard if none exists
        const defaultDashboard = {
            id: Date.now().toString(),
            name: "Imported Dashboard"
        };
        await dashboardStore.put(defaultDashboard);

        // Process projects and tiles
        for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('project_')) {
                // Add project
                const project = {
                    id: value.id || key.replace('project_', ''),
                    name: value.name || 'Imported Project',
                    dashboardId: defaultDashboard.id
                };
                await projectStore.put(project);

                // Process associated tiles
                if (value.tiles) {
                    for (const tile of value.tiles) {
                        await tileStore.put({
                            id: tile.id || Date.now().toString(),
                            name: tile.name,
                            url: tile.url,
                            projectId: project.id,
                            dashboardId: defaultDashboard.id
                        });
                    }
                }
            }
        }

        console.log('Migration completed successfully');
        return true;
    } catch (error) {
        console.error('Migration failed:', error);
        return false;
    }
}
*/
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
        const db = await initDB();
        const tx = db.transaction('tiles', 'readonly');
        const store = tx.objectStore('tiles');

        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async function getProjectById(id) {
        const db = await initDB();
        const tx = db.transaction('projects', 'readonly');
        const store = tx.objectStore('projects');

        return new Promise((resolve, reject) => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror  = () => reject(req.error);
        });
      }


// Import/Export functions moved from options.js
async function exportDashboardsJSON() {
    const db = await initDB();
    const tx = db.transaction(['dashboards', 'projects', 'tiles'], 'readonly');
    const dashboardStore = tx.objectStore('dashboards');
    const projectStore = tx.objectStore('projects');
    const tileStore = tx.objectStore('tiles');

    const dashboards = await new Promise((resolve) => {
        const request = dashboardStore.getAll();
        request.onsuccess = () => resolve(request.result || []);
    });

    const projects = await new Promise((resolve) => {
        const request = projectStore.getAll();
        request.onsuccess = () => resolve(request.result || []);
    });

    const tiles = await new Promise((resolve) => {
        const request = tileStore.getAll();
        request.onsuccess = () => resolve(request.result || []);
    });

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
    a.download = `lifetiles-backup-${new Date().toISOString().split('T')[0]}.json`;
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
                const db = await initDB();
                const tx = db.transaction(['dashboards', 'projects', 'tiles'], 'readwrite');
                
                // Import new data while preserving existing
                for (const dashboard of importData.dashboards) {
                    const newDashboard = {
                        ...dashboard,
                        id: Date.now().toString() + Math.random() // Generate new ID to avoid conflicts
                    };
                    await tx.objectStore('dashboards').add(newDashboard);

                    // Update project references to new dashboard ID
                    const dashboardProjects = importData.projects.filter(p => p.dashboardId === dashboard.id);
                    for (const project of dashboardProjects) {
                        const newProject = {
                            ...project,
                            id: Date.now().toString() + Math.random(),
                            dashboardId: newDashboard.id
                        };
                        await tx.objectStore('projects').add(newProject);

                        // Update tile references to new project ID
                        const projectTiles = importData.tiles.filter(t => t.projectId === project.id);
                        for (const tile of projectTiles) {
                            await tx.objectStore('tiles').add({
                                ...tile,
                                id: Date.now().toString() + Math.random(),
                                projectId: newProject.id,
                                dashboardId: newDashboard.id
                            });
                        }
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
    const looseBookmarks = {
        id: crypto.randomUUID(),
        name: 'Imported Bookmarks',
        tiles: []
    };

    bookmarkBar.children.forEach(child => {
        if (child.url && !isInternalUrl(child.url)) {
            // Single bookmark goes into the looseBookmarks project
            looseBookmarks.tiles.push({
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

    // Only add the loose bookmarks project if it has any tiles
    if (looseBookmarks.tiles.length > 0) {
        projects.push(looseBookmarks);
    }

    return projects;
}

async function importGoogleBookmarks() {
    if (!chrome?.bookmarks) {
        alert('Bookmark access not available. This feature requires the Chrome extension.');
        return;
    }

    // Create and show dashboard selection modal
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.innerHTML = `
        <h2>Select Dashboard</h2>
        <select id="dashboard-select" style="width: 100%; padding: 8px; margin: 10px 0;">
        </select>
        <div class="modal-buttons">
            <button id="cancel-import" class="cancel-button">Cancel</button>
            <button id="confirm-import" class="done-button enabled">Import</button>
        </div>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    // Populate dashboard select using IndexedDB
    try {
        const db = await initDB();
        const tx = db.transaction(['dashboards'], 'readonly');
        const store = tx.objectStore('dashboards');
        const request = store.getAll();

        request.onsuccess = () => {
            const select = document.getElementById('dashboard-select');
            request.result.forEach(dashboard => {
                const option = document.createElement('option');
                option.value = dashboard.id;
                option.textContent = dashboard.name;
                select.appendChild(option);
            });
        };
    } catch (error) {
        console.error('Error loading dashboards:', error);
        modal.remove();
        return;
    }

    // Handle cancel
    document.getElementById('cancel-import').onclick = () => {
        modal.remove();
    };

    // Handle confirm
    document.getElementById('confirm-import').onclick = () => {
        const selectedDashboardId = document.getElementById('dashboard-select').value;

        chrome.bookmarks.getTree(function(bookmarkTree) {
            // The bookmarks bar is the first child in the bookmark tree
            const bookmarkBar = bookmarkTree[0].children[0];
            const projects = processBookmarksBar(bookmarkBar);

            // Save imported projects using IndexedDB
            initDB().then(async db => {
                const tx = db.transaction(['projects', 'tiles'], 'readwrite');
                const projectStore = tx.objectStore('projects');
                const tileStore = tx.objectStore('tiles');

                // Get existing projects to determine order
                const existingProjects = await new Promise((resolve) => {
                    const request = projectStore.index('dashboardId').getAll(selectedDashboardId);
                    request.onsuccess = () => resolve(request.result || []);
                });

                // Add each project and its tiles
                for (const project of projects) {
                    project.dashboardId = selectedDashboardId;
                    // Save project
                    await projectStore.add(project);

                    // Add tiles for this project
                    if (project.tiles) {
                        for (const tile of project.tiles) {
                            tile.projectId = project.id;
                            tile.dashboardId = selectedDashboardId;
                            await tileStore.put(tile);
                        }
                    }
                }

                modal.remove();
                showStatus('Bookmarks imported successfully!');
                
                // Delay reload to allow status message to be seen
                setTimeout(() => {
                    window.location.reload();
                }, 2000);
            }).catch(error => {
                console.error('Error importing bookmarks:', error);
                showStatus('Error importing bookmarks');
            });
        });
    };
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
