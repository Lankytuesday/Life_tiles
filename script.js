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

// Favicons cache TTL (24h). Set to 6h if you prefer faster refreshes.
const FAVICON_TTL_MS = 86400000;
// Probe an image URL to verify it actually loads (no fetch → no ORB)
async function probeImage(src, timeout = 1800) {
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
// One-time cleanup: remove legacy cached favicons that point to gstatic
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
        if (typeof f === 'string' && /(?:^|\/\/)t\d*\.gstatic\.com\/faviconV2/i.test(f)) {
          store.delete(row.hostname);
          sessionFaviconCache.delete?.(row.hostname);
        }
      }
    } catch {}
  }
purgeLegacyFavicons(); // fire-and-forget migration
   
// Per-page in-memory cache to avoid duplicate probes
const sessionFaviconCache = new Map();

// Probe a favicon by actually loading it as an <img> (avoids ORB/CORB)
async function loadFaviconForHost(hostname) {
    if (sessionFaviconCache.has(hostname)) return sessionFaviconCache.get(hostname);
  
    const tryImg = (src) => new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const finish = ok => { if (done) return; done = true; resolve(ok ? src : null); };
      const t = setTimeout(() => finish(false), 1800);
      img.onload = () => { clearTimeout(t); finish(img.naturalWidth > 0 && img.naturalHeight > 0); };
      img.onerror = () => { clearTimeout(t); finish(false); };
      img.referrerPolicy = 'no-referrer';
      img.src = src;
    });
  
    // Prefer Google S2 → then DuckDuckGo → then icon.horse (CDN-only; avoids ORB/404 spam)
    let found = await tryImg(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(hostname)}`);
    if (!found) found = await tryImg(`https://icons.duckduckgo.com/ip3/${hostname}.ico`);
    if (!found) found = await tryImg(`https://icon.horse/icon/${hostname}`);


  
    sessionFaviconCache.set(hostname, found || ''); // '' = tried already this session
    if (found) {
      // persist to IndexedDB
      try {
        const db = await initDB();
        const tx = db.transaction(['favicons'], 'readwrite');
        tx.objectStore('favicons').put({ hostname, favicon: found, timestamp: Date.now() });
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

window.chrome = {
        storage: {
            sync: {
                get: function(keys, callback) {
                    const data = {};
                    if (keys === null) {
                        // Get all items from localStorage
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            try {
                                data[key] = JSON.parse(localStorage.getItem(key));
                            } catch (e) {
                                data[key] = localStorage.getItem(key);
                            }
                        }
                    } else if (typeof keys === 'string') {
                        data[keys] = localStorage.getItem(keys) ? JSON.parse(localStorage.getItem(keys)) : null;
                    } else if (Array.isArray(keys)) {
                        keys.forEach(key => {
                            data[key] = localStorage.getItem(key) ? JSON.parse(localStorage.getItem(key)) : null;
                        });
                    } else if (typeof keys === 'object') {
                        Object.keys(keys).forEach(key => {
                            const value = localStorage.getItem(key);
                            data[key] = value ? JSON.parse(value) : keys[key];
                        });
                    }
                    callback(data);
                },
                set: function(items, callback) {
                    Object.keys(items).forEach(key => {
                        localStorage.setItem(key, JSON.stringify(items[key]));
                    });
                    if (callback) callback();
                }
            }
        }
    };
*/
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
  
  
document.addEventListener("DOMContentLoaded", async function () {
    wireLiveUpdates();
    // Initialize IndexedDB
    try {
        const db = await initDB();
        console.log('IndexedDB initialized successfully');
    } catch (error) {
        console.error('Failed to initialize IndexedDB:', error);
    }

    // Dashboard Modal Elements
    const newDashboardBtn = document.getElementById("new-dashboard");
    const dashboardModal = document.getElementById("dashboard-modal");
    const dashboardNameInput = document.getElementById("dashboard-name-input");
    let submitDashboardBtn = document.getElementById("submit-dashboard-name");
    const closeDashboardModal = document.getElementById("close-dashboard-modal");
    const dashboardSelectorContainer = document.getElementById("dashboard-selector-container");

    // Verify critical elements exist
    if (!dashboardSelectorContainer) {
        console.error('Dashboard selector container not found in DOM');
        return;
    }

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
    // (optional but helpful) prevent dragging the “New Project” button
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
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            // Sort dashboards by order property
            if (dashboards && dashboards.length > 0) {
                dashboards.sort((a, b) => (a.order || 0) - (b.order || 0));
            }

            if (!dashboards || dashboards.length === 0) {
                // Create default dashboard
                const defaultDashboard = {
                    id: Date.now().toString(),
                    name: "My Dashboard"
                };

                const tx = db.transaction(['dashboards'], 'readwrite');
                const store = tx.objectStore('dashboards');
                await store.add(defaultDashboard);

                localStorage.setItem('currentDashboardId', defaultDashboard.id);
                createDashboardTabs([defaultDashboard], defaultDashboard.id);
                currentDashboardId = defaultDashboard.id;
                return [defaultDashboard];
            }

            const currentId = localStorage.getItem('currentDashboardId') || dashboards[0].id;
            
            // Validate that the current dashboard still exists
            const validCurrentId = dashboards.find(d => d.id === currentId) ? currentId : dashboards[0].id;
            if (validCurrentId !== currentId) {
                localStorage.setItem('currentDashboardId', validCurrentId);
                currentDashboardId = validCurrentId;
            }
            
            createDashboardTabs(dashboards, validCurrentId);

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

function createDashboardTabs(dashboards, activeId) {
        // Ensure we have a valid container
        if (!dashboardSelectorContainer) {
            console.error('Dashboard selector container not found');
            return;
        }

        // Clear existing tabs
        dashboardSelectorContainer.innerHTML = '';

        // Ensure we have dashboards and a valid activeId
        if (!dashboards || dashboards.length === 0) {
            console.error('No dashboards provided to createDashboardTabs');
            return;
        }

        // Create current dashboard selector
        const currentDashboard = dashboards.find(d => d.id === activeId) || dashboards[0];
        if (!currentDashboard) {
            console.error('No current dashboard found');
            return;
        }

        // Create the current dashboard display element
        const currentElement = document.createElement('div');
        currentElement.id = 'dashboard-selector-current';
        currentElement.textContent = currentDashboard.name;

        // Only add tooltip for long dashboard names
        if (currentDashboard.name.length > 20) {
            currentElement.title = currentDashboard.name;
        }

        // Only show dropdown if there's more than one dashboard
        if (dashboards.length > 1) {
            // Create dropdown container
            const dropdownContainer = document.createElement('div');
            dropdownContainer.id = 'dashboard-dropdown';

            // Add click handler to toggle dropdown
            currentElement.addEventListener('click', function() {
                currentElement.classList.toggle('active');
                dropdownContainer.classList.toggle('active');
            });

            // Add dashboards to dropdown
            dashboards.forEach(dashboard => {
                const tab = document.createElement('button');
                tab.classList.add('dashboard-tab');
                tab.textContent = dashboard.name;
                tab.dataset.dashboardId = dashboard.id;

                // Add tooltip only if text might overflow
                if (dashboard.name.length > 20) {
                    tab.title = dashboard.name;
                }

                // Apply custom color if available
                if (dashboard.color) {
                    tab.style.setProperty('--dashboard-indicator-color', dashboard.color);
                }

                if (dashboard.id === activeId) {
                    tab.classList.add('active');
                }

                tab.addEventListener('click', function() {
                    switchDashboard(dashboard.id);
                    currentElement.textContent = dashboard.name;

                    // Only set title attribute if name is likely to be truncated
                    if (dashboard.name.length > 20) {
                        currentElement.title = dashboard.name;
                    } else {
                        currentElement.removeAttribute('title');
                    }

                    currentElement.classList.remove('active');
                    dropdownContainer.classList.remove('active');
                });

                dropdownContainer.appendChild(tab);
            });

            // Close dropdown when clicking outside
            document.addEventListener('click', function(e) {
                if (!dashboardSelectorContainer.contains(e.target)) {
                    currentElement.classList.remove('active');
                    dropdownContainer.classList.remove('active');
                }
            });

            // Indicate that dropdown is available with a visual cue
            currentElement.style.cursor = 'pointer';
            currentElement.classList.add('has-dropdown');

            // Add elements to container
            dashboardSelectorContainer.appendChild(currentElement);
            dashboardSelectorContainer.appendChild(dropdownContainer);
        } else {
            // For a single dashboard, just show the name with no dropdown functionality
            currentElement.style.cursor = 'default';
            // Remove the dropdown arrow for single dashboard
            currentElement.style.padding = '12px 18px';
            currentElement.classList.add('single-dashboard');
            dashboardSelectorContainer.appendChild(currentElement);
        }
    }

    function switchDashboard(dashboardId) {
        // Update active tab
        document.querySelectorAll('.dashboard-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.dashboardId === dashboardId);
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
        loadProjectsForDashboard(dashboardId);
    }

    async function loadProjects(projects = []) {
        if (projects && projects.length > 0) {
            // Sort projects by order before creating elements
            projects.sort((a, b) => (a.order || 0) - (b.order || 0));

            const db = await initDB();
            const tx = db.transaction(['tiles'], 'readonly');
            const tileStore = tx.objectStore('tiles');

            for (const projectData of projects) {
                // Load tiles for this project
                const tiles = await new Promise((resolve) => {
                    const request = tileStore.index('projectId').getAll(projectData.id);
                    request.onsuccess = () => {
                        let tiles = request.result || [];
                
                        // Sort by order (fallback to createdAt if missing)
                        tiles.sort(
                            (a, b) =>
                                (a.order ?? 1e9) - (b.order ?? 1e9) ||
                                (a.createdAt || 0) - (b.createdAt || 0)
                        );
                
                        // Backfill missing order values
                        let needsSave = false;
                        tiles.forEach((t, i) => {
                            if (t.order == null) {
                                t.order = i;
                                needsSave = true;
                            }
                        });
                
                        if (needsSave) {
                            const txSave = db.transaction(['tiles'], 'readwrite');
                            const storeSave = txSave.objectStore('tiles');
                            tiles.forEach(t => storeSave.put(t));
                        }
                
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
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async function saveTile(projectId, tileData) {
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
                dashboardId: currentDashboardId
            });
            request.onsuccess = () => resolve();
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
        editButton.textContent = "Edit";
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

                    // Reset the submit button back to "create" mode
                    const oldBtn = submitProjectBtn;
                    submitProjectBtn = oldBtn.cloneNode(true);
                    oldBtn.parentNode.replaceChild(submitProjectBtn, oldBtn);
                    submitProjectBtn.addEventListener('click', createNewProject);
                };
            };
        });
    };

        
    const copyButton = document.createElement("button");
    copyButton.textContent = "Copy to Dashboard";
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
            dashboards.sort((a, b) => (a.order || 0) - (b.order || 0));
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
        removeButton.textContent = "Remove";
        removeButton.onclick = async (e) => {
            e.stopPropagation();
            if (confirm('Are you sure you want to remove this project?')) {
                const db = await initDB();
                const tx = db.transaction(['projects'], 'readwrite');
                const store = tx.objectStore('projects');
                const request = store.delete(projectData.id);
                request.onsuccess = () => project.remove();
            }
        };

        menu.appendChild(editButton);
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
            dataIdAttr: 'data-tile-id',
            animation: 150,
            draggable: '.tile',
            handle: '.tile',
            group: 'tiles',
            ghostClass: 'sortable-ghost',
            filter: '.add-tile-button', // Prevent sorting on add button
            preventOnFilter: false,
            onStart: function(evt) {
                document.body.classList.add('dragging');
                // Disable all add buttons during drag
                document.querySelectorAll('.add-tile-button').forEach(btn => {
                    btn.classList.add('dragging-disabled');
                });
            },
            onEnd: function(evt) {
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

                var fromProjectId = evt.from.closest('.project').dataset.projectId;
                var toProjectId = evt.to.closest('.project').dataset.projectId;

                // Ensure the transaction completes before moving on
                requestAnimationFrame(() => {
                    updateTileOrder(evt, fromProjectId, toProjectId);
                });
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
            const tileData = {
                id: Date.now().toString(),
                name: tileName,
                url: tileUrl,
                projectId: currentProjectId,
                dashboardId: currentDashboardId
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
            const tileData = {
                id: Date.now().toString(),
                name: tileName,
                url: tileUrl,
                projectId: currentProjectId,
                dashboardId: currentDashboardId
            };

            await saveTile(currentProjectId, tileData);
            createTileElement(currentProjectContainer, tileData);
            closePopupModalHandler();
        }
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

    // Dashboard Menu Event Listeners
    const dashboardMenuTrigger = document.getElementById("dashboard-menu-trigger");
    const dashboardActionsMenu = document.getElementById("dashboard-actions-menu");
    const editDashboardBtn = document.getElementById("edit-dashboard");
    const removeDashboardBtn = document.getElementById("remove-dashboard");
    const manageDashboardsBtn = document.getElementById("manage-dashboards");

    dashboardMenuTrigger.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        closeAllMenus();
        dashboardActionsMenu.classList.toggle("active");
        dashboardMenuTrigger.classList.toggle("active");
    });

    // Close menu when clicking outside
    document.addEventListener("click", function(e) {
        if (!dashboardActionsMenu.contains(e.target) && e.target !== dashboardMenuTrigger) {
            dashboardActionsMenu.classList.remove("active");
            dashboardMenuTrigger.classList.remove("active");
        }
    });

    // New Dashboard button
    newDashboardBtn.addEventListener("click", function() {
        dashboardActionsMenu.classList.remove("active");
        dashboardMenuTrigger.classList.remove("active");
        dashboardModal.style.display = "flex";
        dashboardNameInput.value = "";
        dashboardNameInput.focus();
        dashboardModal.querySelector('h2').textContent = "Create New Dashboard";
    });

    // Edit Dashboard button
    editDashboardBtn.addEventListener("click", async function() {
        dashboardActionsMenu.classList.remove("active");
        dashboardMenuTrigger.classList.remove("active");
        if (currentDashboardId) {
            const db = await initDB();
            const tx = db.transaction(['dashboards'], 'readonly');
            const store = tx.objectStore('dashboards');
            const request = store.get(currentDashboardId);
            request.onsuccess = async () => {
                const dashboard = request.result;
                if (dashboard) {
                    dashboardModal.style.display = "flex";
                    dashboardModal.querySelector('h2').textContent = "Edit Dashboard";
                    dashboardNameInput.value = dashboard.name;
                    validateDashboardInput();

                    // Replace the default create handler with an edit handler
                    const newSubmitBtn = submitDashboardBtn.cloneNode(true);
                    submitDashboardBtn.parentNode.replaceChild(newSubmitBtn, submitDashboardBtn);
                    submitDashboardBtn = newSubmitBtn;

                    submitDashboardBtn.addEventListener('click', async function editDashboardHandler() {
                        const newName = dashboardNameInput.value.trim();

                        if (newName) {
                            const db = await initDB();
                            const tx = db.transaction(['dashboards'], 'readwrite');
                            const store = tx.objectStore('dashboards');;
                            const request = store.get(currentDashboardId);
                            request.onsuccess = async () => {
                                const updatedDashboard = request.result;
                                updatedDashboard.name = newName;
                                const updateRequest = store.put(updatedDashboard);
                                updateRequest.onsuccess = () => {
                                    // Only update the dashboard selector without reloading projects
                                    updateDashboardSelector();
                                    closeDashboardModalHandler();

                                    // Reset the submit button to create mode
                                    const oldBtn = submitDashboardBtn;
                                    submitDashboardBtn = oldBtn.cloneNode(true);
                                    oldBtn.parentNode.replaceChild(submitDashboardBtn, oldBtn);
                                    submitDashboardBtn.addEventListener('click', createNewDashboard);
                                };
                            };
                        }
                    });
                }
            };
        }
    });

    // Remove Dashboard button
    removeDashboardBtn.addEventListener("click", async function() {
        dashboardActionsMenu.classList.remove("active");
        dashboardMenuTrigger.classList.remove("active");
        if (currentDashboardId) {
            const db = await initDB();
            const tx = db.transaction(['dashboards'], 'readwrite');
            const store = tx.objectStore('dashboards');
            const dashboards = await loadDashboards();
            if (dashboards.length <= 1) {
                alert("Cannot remove the last dashboard. Create a new dashboard first.");
                return;
            }

            if (confirm("Are you sure you want to remove this dashboard?")) {
                // Get all dashboards except the one being deleted
                const remainingDashboards = dashboards.filter(d => d.id !== currentDashboardId);

                // Find the index of the current dashboard being deleted
                const currentIndex = dashboards.findIndex(d => d.id === currentDashboardId);

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

                try {
                    // Clear the projects container first
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

                    // Use a single transaction for all operations
                    const tx = db.transaction(['dashboards', 'projects', 'tiles'], 'readwrite');
                    const dashboardStore = tx.objectStore('dashboards');
                    const projectStore = tx.objectStore('projects');
                    const tileStore = tx.objectStore('tiles');

                    // Delete the dashboard first
                    await new Promise((resolve, reject) => {
                        const request = dashboardStore.delete(currentDashboardId);
                        request.onsuccess = resolve;
                        request.onerror = reject;
                    });

                    // Delete all projects for this dashboard
                    const projects = await new Promise((resolve) => {
                        const request = projectStore.index('dashboardId').getAll(currentDashboardId);
                        request.onsuccess = () => resolve(request.result || []);
                    });

                    for (const project of projects) {
                        // Delete all tiles for this project
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

                    // Update UI and switch to new dashboard
                    localStorage.setItem('currentDashboardId', newCurrentId);
                    currentDashboardId = newCurrentId;

                    // Clear and reload the UI
                    await loadDashboards();
                    await loadProjectsForDashboard(newCurrentId);
                } catch (error) {
                    console.error('Error deleting dashboard:', error);
                    alert('Failed to delete dashboard. Please try again.');
                }
            }
        }
    });

    // Manage Dashboards button
    manageDashboardsBtn.addEventListener("click", function() {
        dashboardActionsMenu.classList.remove("active");
        dashboardMenuTrigger.classList.remove("active");
        openManageDashboardsModal();
    });

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


    async function createNewDashboard() {
        const dashboardName = dashboardNameInput.value.trim();

        if (dashboardName) {
            const dashboardData = {
                id: Date.now().toString(),
                name: dashboardName,
                projects: []
            };

            const db = await initDB();
            const tx = db.transaction(['dashboards'],'readwrite');
            const store = tx.objectStore('dashboards');
            const request = store.add(dashboardData);

            request.onsuccess = async () => {
                // Clear the projects container first
                document.getElementById('projects-container').innerHTML = '';

                // Add the New Project button
                const newProjectButton = document.createElement('button');
                newProjectButton.id = 'new-project';
                newProjectButton.className = 'new-project';
                newProjectButton.textContent = 'New Project';
                newProjectButton.addEventListener('click', function() {
                    projectModal.style.display = "flex";
                    projectNameInput.focus();
                });
                document.getElementById('projects-container').appendChild(newProjectButton);

                // Update state and UI
                localStorage.setItem('currentDashboardId', dashboardData.id);
                currentDashboardId = dashboardData.id;
                await loadDashboards();
                closeDashboardModalHandler();
            };
        }
    }

    function closeAllMenus() {
        const allMenuTriggers = document.querySelectorAll('.project-menu-trigger, .tile-menu-trigger, .dashboard-menu-trigger');
        allMenuTriggers.forEach(trigger => trigger.classList.remove('active'));
        const allMenus = document.querySelectorAll('.project-menu, .tile-menu, .dashboard-actions-menu');
        allMenus.forEach(menu => menu.classList.remove('active'));
    }

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
                dashboards.sort((a, b) => (a.order || 0) - (b.order || 0));
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
            dashboards.sort((a, b) => (a.order || 0) - (b.order || 0));

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
                                tileStore.delete(tile.id);
                            }

                            projectStore.delete(project.id);
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
                item.remove();

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
                dashboards.sort((a, b) => (a.order || 0) - (b.order || 0));
            }

            if (dashboards && dashboards.length > 0) {
                const currentId = localStorage.getItem('currentDashboardId') || dashboards[0].id;
                
                // Validate that the current dashboard still exists
                const validCurrentId = dashboards.find(d => d.id === currentId) ? currentId : dashboards[0].id;
                if (validCurrentId !== currentId) {
                    localStorage.setItem('currentDashboardId', validCurrentId);
                    currentDashboardId = validCurrentId;
                }
                
                createDashboardTabs(dashboards, validCurrentId);
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
        const tile = document.createElement("div");
        tile.className = "tile";
        tile.dataset.tileId = tileData.id;

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
        editButton.textContent = "Edit";
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

                if (newName && (() => {
                    try { const u = new URL(newUrl); return u.protocol === 'http:' || u.protocol === 'https:'; }
                    catch { return false; }
                  })()) {                  
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
        removeButton.textContent = "Remove";
        removeButton.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (confirm('Are you sure you want to remove this tile?')) {
                const db = await initDB();
                const tx = db.transaction(['tiles'], 'readwrite');
                const store = tx.objectStore('tiles');
                const deleteRequest = store.delete(tileData.id);
                deleteRequest.onsuccess = () => tile.remove();
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
              e.preventDefault(); // Prevent default navigation
          
              // block internal schemes (chrome://, chrome-extension://, etc.)
              try {
                const u = new URL(tileData.url);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                  alert('This internal Chrome page can’t be opened from Lifetiles.');
                  return;
                }
              } catch {
                return; // bad URL, do nothing
              }
          
              if (e.metaKey || e.ctrlKey) {
                window.open(tileData.url, '_blank');
              } else {
                window.location.href = tileData.url;
              }
            }
          });
          

        const thumbnailElement = document.createElement("div");
        thumbnailElement.className = "tile-thumbnail";

        try {
            const url = new URL(tileData.url);
            const skipFavicon = url.protocol !== 'http:' && url.protocol !== 'https:';

            // Helper function to show initials when favicon fails
            const showInitials = () => {
                const initials = getSiteInitials(url.hostname) || 'LT';
                const bgColor = generateColorFromString(url.hostname);
                thumbnailElement.style.backgroundImage = 'none';
                thumbnailElement.style.backgroundColor = bgColor;
                thumbnailElement.innerHTML = `<span class="tile-initials">${initials}</span>`;
            };
        if (skipFavicon) { showInitials(); } else {
           

            let src = await checkFaviconCache(url.hostname);

            if (src) {
              const ok = await probeImage(src);
              if (!ok) {
                // purge bad cache + session memo, then retry via CDN probes
                try {
                  const db = await initDB();
                  const tx = db.transaction(['favicons'], 'readwrite');
                  tx.objectStore('favicons').delete(url.hostname);
                } catch {}
                sessionFaviconCache.delete?.(url.hostname);
                src = await loadFaviconForHost(url.hostname);
              }
            } else {
              src = await loadFaviconForHost(url.hostname);
            }
            
            if (src) {
              thumbnailElement.style.backgroundColor = 'transparent';
              thumbnailElement.style.backgroundImage = `url("${src}")`;
              thumbnailElement.innerHTML = '';
            } else {
              showInitials();
            }
        }
        } catch (error) {
            console.error('Error handling thumbnail:', error);
            thumbnailElement.style.backgroundImage = 'none';
            thumbnailElement.style.backgroundColor = generateColorFromString('lifetiles');
            thumbnailElement.innerHTML = '<span class="tile-initials">LT</span>';
        }

        const nameElement = document.createElement("div");
        nameElement.className = "tile-name";
        nameElement.textContent = truncateText(tileData.name, 60);
        nameElement.setAttribute("title", tileData.name);
        tile.setAttribute("title", tileData.name);

        tile.appendChild(thumbnailElement);
        tile.appendChild(nameElement);

        // Find the "Add Tile" button and insert the new tile before it
        const addTileButton = container.querySelector('.add-tile-button');
        container.insertBefore(tile, addTileButton);
    }

    function showPopupSaveModal(url, title) {
        currentProjectContainer = document.querySelector('.tiles-container');
        currentProjectId = currentProjectContainer.parentElement.dataset.projectId;

        popupTileUrlInput.value = url;
        popupTileNameInput.value = title || '';
        validatePopupTileInputs();

        popupSaveModal.style.display = "flex";
        popupTileNameInput.focus();
    }

    document.addEventListener("click", (e) => {
        if (!e.target.closest('.project-menu') &&
            !e.target.closest('.project-menu-trigger') &&
            !e.target.closest('.tile-menu') &&
            !e.target.closest('.tile-menu-trigger') &&
            !e.target.closest('.dashboard-actions-menu') &&
            !e.target.closest('.dashboard-menu-trigger')) {
            closeAllMenus();
        }
    });
/*
    function editDashboard(dashboardId, tab) {
        dashboardModal.style.display = "flex";
        dashboardModal.querySelector('h2').textContent = "Edit Dashboard";

        chrome.storage.sync.get(['dashboards'], function(result) {
            const dashboards = result.dashboards || [];
            const dashboard = dashboards.find(d => d.id === dashboardId);
            if (dashboard) {
                dashboardNameInput.value = dashboard.name;
                validateDashboardInput();

                // Replace the default create handler with an edit handler
                const newSubmitBtn = submitDashboardBtn.cloneNode(true);
                submitDashboardBtn.parentNode.replaceChild(newSubmitBtn, submitDashboardBtn);
                submitDashboardBtn = newSubmitBtn;

                submitDashboardBtn.addEventListener('click', async function editDashboardHandler() {
                    const newName = dashboardNameInput.value.trim();
                    if (newName) {
                        const db = await initDB();
                        const tx = db.transaction(['dashboards'], 'readwrite');
                        const store = tx.objectStore('dashboards');
                        const request = store.get(dashboardId);
                        request.onsuccess = async () => {
                            const updatedDashboard = request.result;
                            updatedDashboard.name = newName;
                            const updateRequest = store.put(updatedDashboard);
                            updateRequest.onsuccess = () => {
                                // Update the tab name
                                tab.textContent = newName;
                                closeDashboardModalHandler();

                                // Reset the submit button to create mode
                                const oldBtn = submitDashboardBtn;
                                submitDashboardBtn = oldBtn.cloneNode(true);
                                oldBtn.parentNode.replaceChild(submitDashboardBtn, oldBtn);
                                submitDashboardBtn.addEventListener('click', createNewDashboard);
                            };
                        };
                    }
                });
            }
        });
    }
*/
    async function updateProjectOrder(evt) {
        const db = await initDB();
        const tx = db.transaction(['projects'], 'readwrite');
        const projectStore = tx.objectStore('projects');

        const projectElements = Array.from(document.querySelectorAll('.project'));

        // Update each project's order based on its current position
        const promises = projectElements.map(async (element, index) => {
            const projectId = element.dataset.projectId;
            return new Promise((resolve, reject) => {
                const request = projectStore.get(projectId);
                request.onsuccess = () => {
                    const project = request.result;
                    if (project) {
                        project.order = index;
                        const updateRequest = projectStore.put(project);
                        updateRequest.onsuccess = () => resolve();
                        updateRequest.onerror = () => reject(updateRequest.error);
                    } else {
                        resolve();
                    }
                };
                request.onerror = () => reject(request.error);
            });
        });

        await Promise.all(promises);
    }

    async function updateTileOrder(evt, fromProjectId, toProjectId) {
        try {
          const db = await initDB();
          const tx = db.transaction(['tiles'], 'readwrite');
          const store = tx.objectStore('tiles');
      
          // 1) Get the authoritative order from Sortable (uses dataIdAttr)
          const toSortable   = Sortable.get(evt.to);
          const fromSortable = (evt.from !== evt.to) ? Sortable.get(evt.from) : null;
      
          const toIds   = (toSortable   && typeof toSortable.toArray === 'function')   ? toSortable.toArray()   : [];
          const fromIds = (fromSortable && typeof fromSortable.toArray === 'function') ? fromSortable.toArray() : [];
      
          const writeOne = (id, index, newProjectId) => new Promise((resolve, reject) => {
            const getReq = store.get(id);
            getReq.onsuccess = () => {
              const rec = getReq.result;
              if (!rec) return resolve();
              rec.order = index;
              if (newProjectId != null) rec.projectId = newProjectId; // cross-project moves
              const putReq = store.put(rec);
              putReq.onsuccess = resolve;
              putReq.onerror  = () => reject(putReq.error);
            };
            getReq.onerror = () => reject(getReq.error);
          });
      
          // 2) Persist destination list (always)
          const writes = [];
          for (let i = 0; i < toIds.length; i++) writes.push(writeOne(toIds[i], i, toProjectId));
      
          // 3) If moved across projects, reindex the source list too
          if (fromProjectId !== toProjectId && fromIds.length) {
            for (let i = 0; i < fromIds.length; i++) writes.push(writeOne(fromIds[i], i, null));
          }
      
          await Promise.all(writes);
        } catch (err) {
          console.error('updateTileOrder failed:', err);
        }
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
        const request = indexedDB.open('lifetiles', 5);

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
// --- helper: get current tile order from DOM (ignores add-tile button) ---
function getOrderedTileIds(containerEl) {
    return Array.from(containerEl.children)
      .filter((el) => el.matches('.tile') && !el.classList.contains('add-tile-button'))
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
    } catch (e) {
      console.error('updateProjectOrder failed:', e);
    }
  }
  