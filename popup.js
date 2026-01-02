// --- Session Buddy–style helpers (no top-level await) ---

// Get the last-focused normal Chrome window id (not the popup)
async function getTargetWindowId() {
    try {
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (w && typeof w.id === 'number') return w.id;
    } catch (_) {
      // ignore
    }
    // Fallback: use any normal window if none are focused (rare)
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    return wins[0]?.id ?? null;
  }
  
  // Focus existing dashboard tab in that window, or create it there
  async function focusOrCreateDashboardInWindow(windowId) {
    const dashboardUrl = chrome.runtime.getURL('index.html');
  
    // Look for an existing Lifetiles tab in THIS window
    const matches = await chrome.tabs.query({
      windowId,
      url: [dashboardUrl, `${dashboardUrl}*`]
    });
  
    if (matches.length) {
      // Prefer the most-recently-used if multiples exist
      matches.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
      await chrome.tabs.update(matches[0].id, { active: true });
      await chrome.windows.update(windowId, { focused: true });
    } else {
      // Create the tab *in that same window* (prevents Chrome from opening a new window)
      await chrome.tabs.create({ windowId, url: dashboardUrl, active: true });
    }
  }
  const INTERNAL_SCHEME_RE = /^(?:chrome:|chrome-extension:|devtools:|edge:|brave:|opera:|vivaldi:|about:|chrome-search:|moz-extension:|file:)$/i;
  function isInternalUrl(u) {
    try { return INTERNAL_SCHEME_RE.test(new URL(u).protocol); }
    catch { return true; }
  }
  

  document.addEventListener('DOMContentLoaded', async function() {
      // ✅ Replaced: Session Buddy–style “Go to dashboard”
      {
        const btn =
          document.getElementById('dashboard-link') ||
          Array.from(document.querySelectorAll('button,a')).find(
            el => /go to dashboard/i.test(el.textContent || '')
          );
  
        if (btn) {
          btn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
              const windowId = await getTargetWindowId();
              if (windowId == null) {
                // No normal windows open — open one and bail
                const url = chrome.runtime.getURL('index.html');
                await chrome.windows.create({ url });
              } else {
                await focusOrCreateDashboardInWindow(windowId);
              }
            } catch (err) {
              console.error('Go to dashboard failed:', err);
            } finally {
              // Nice UX: close the popup after jumping
              window.close();
            }
          });
        }
      }
  

    const dropdownContainer = document.getElementById('custom-dropdown-container');
    const dropdownHeader = document.getElementById('dropdown-header');
    const dropdownOptions = document.getElementById('dropdown-options');
    const tileDetails = document.getElementById('tile-details');
    const tileNameInput = document.getElementById('tile-name-input');
    const tileUrlInput = document.getElementById('tile-url-input');

    // Save options elements
    const saveOptionsContainer = document.getElementById('save-options-container');
    const saveOptionsHeader = document.getElementById('save-options-header');
    const saveOptionsList = document.getElementById('save-options-list');
    const saveCurrentOption = document.getElementById('save-current-option');
    const saveAllOption = document.getElementById('save-all-option');
    const saveButton = document.getElementById('save-button');
    const quickSaveBtn = document.getElementById('quick-save-btn');

    // Track selected project value and save mode
    let selectedProjectValue = '';
    let selectedProjectName = '';
    let saveMode = 'current'; // 'current' or 'all'

    // Initially hide tile details and disable save button
    tileDetails.style.display = 'none';
    saveButton.disabled = true;

    // Initialize IndexedDB
    const db = await initDB();

    // Pre-populate tile name/URL immediately on popup load
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab && currentTab.url && !isInternalUrl(currentTab.url)) {
        tileNameInput.value = currentTab.title || '';
        tileUrlInput.value = currentTab.url || '';
    }

    // Check for last used project
    const lastProjectData = localStorage.getItem('lifetiles_lastProject');
    let lastProject = null;
    if (lastProjectData) {
        try {
            lastProject = JSON.parse(lastProjectData);
            // Show quick save button if we have a last project and valid current tab
            if (lastProject && lastProject.name && currentTab && currentTab.url && !isInternalUrl(currentTab.url)) {
                quickSaveBtn.style.display = 'block';
                quickSaveBtn.querySelector('.quick-save-project-name').textContent = lastProject.name;
            }
        } catch (e) {
            console.error('Failed to parse last project:', e);
        }
    }

    // Quick Save button handler
    quickSaveBtn.addEventListener('click', async () => {
        if (!lastProject || !lastProject.value) return;

        const { dashboardId, projectId } = JSON.parse(lastProject.value);
        const tileName = tileNameInput.value.trim() || currentTab.title || 'Untitled';
        const tileUrl = currentTab.url;

        if (!tileUrl || isInternalUrl(tileUrl)) return;

        const tileData = {
            id: Date.now().toString(),
            name: tileName,
            url: tileUrl,
            projectId: projectId,
            dashboardId: dashboardId
        };

        const tx = db.transaction(['tiles'], 'readwrite');
        const tileStore = tx.objectStore('tiles');
        const req = tileStore.add(tileData);
        req.onsuccess = () => {
            try {
                const bc = new BroadcastChannel('lifetiles');
                bc.postMessage({ type: 'tiles:changed' });
                bc.close();
            } catch {}
            if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
                try {
                    chrome.runtime.sendMessage({ type: 'tiles:changed' }, () => {
                        void chrome.runtime.lastError;
                    });
                } catch (_) {}
            }
            window.close();
        };
        req.onerror = (e) => console.error('Quick save failed:', e);
    });

    // Toggle project dropdown visibility
    dropdownHeader.addEventListener('click', (event) => {
        event.stopPropagation();
        dropdownOptions.classList.toggle('dropdown-hidden');
        // Hide save options dropdown if open
        saveOptionsList.classList.add('dropdown-hidden');
    });

    // Toggle save options dropdown visibility
    saveOptionsHeader.addEventListener('click', (event) => {
        event.stopPropagation();
        saveOptionsList.classList.toggle('dropdown-hidden');
        // Hide project dropdown if open
        dropdownOptions.classList.add('dropdown-hidden');
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', (event) => {
        if (!dropdownContainer.contains(event.target)) {
            dropdownOptions.classList.add('dropdown-hidden');
        }
        if (!saveOptionsContainer.contains(event.target)) {
            saveOptionsList.classList.add('dropdown-hidden');
        }
    });

    // Helper function to select a project
    function selectProject(projectValue, projectName) {
        document.querySelectorAll('.dropdown-option').forEach(opt => {
            opt.classList.remove('selected');
            if (opt.dataset.value === projectValue) {
                opt.classList.add('selected');
            }
        });
        dropdownHeader.textContent = projectName;
        selectedProjectValue = projectValue;
        selectedProjectName = projectName;
        dropdownOptions.classList.add('dropdown-hidden');

        // Save last-used project to localStorage
        const projectData = JSON.parse(projectValue);
        const savedProject = {
            value: projectValue,
            name: projectName,
            dashboardId: projectData.dashboardId
        };
        localStorage.setItem('lifetiles_lastProject', JSON.stringify(savedProject));
        localStorage.setItem('lifetiles_lastDashboard', String(projectData.dashboardId));

        // Update lastProject variable and hide Quick Save button (user is in full flow now)
        lastProject = savedProject;
        quickSaveBtn.style.display = 'none';

        tileDetails.style.display = 'block';
        validateInputs();
        tileNameInput.focus();
    }

    // Load all projects from all dashboards into dropdown
    const tx = db.transaction(['dashboards', 'projects'], 'readonly');
    const dashboardStore = tx.objectStore('dashboards');
    const projectStore = tx.objectStore('projects');

    const dashboardsRequest = dashboardStore.getAll();
    dashboardsRequest.onsuccess = async () => {
        let dashboards = dashboardsRequest.result;

        // Sort dashboards by order property
        if (dashboards && dashboards.length > 0) {
            const orderNum = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
            dashboards.sort((a, b) => orderNum(a) - orderNum(b) || String(a.id).localeCompare(String(b.id)));            
        }

        // Clear existing options
        const scrollArea = document.createElement('div');
        scrollArea.className = 'dropdown-scroll-area';

        // Add initial instructions
        const instructionElement = document.createElement('div');
        instructionElement.className = 'dropdown-placeholder';
        instructionElement.textContent = '-- Select a project --';
        scrollArea.appendChild(instructionElement);
        dropdownOptions.innerHTML = '';
        dropdownOptions.appendChild(scrollArea);

        // Get last-used dashboard from localStorage
        const lastUsedDashboardId = localStorage.getItem('lifetiles_lastDashboard');
        console.log('Last used dashboard from localStorage:', lastUsedDashboardId);

        // Create groups for each dashboard
        let firstDashboardId = null;

        for (const dashboard of dashboards) {
            const projectsRequest = projectStore.index('dashboardId').getAll(dashboard.id);
            const projects = await new Promise(resolve => {
                projectsRequest.onsuccess = () => resolve(projectsRequest.result);
            });

            if (projects.length > 0) {
                // Track first dashboard with projects
                if (!firstDashboardId) {
                    firstDashboardId = String(dashboard.id);
                }

                // Sort projects by order property to match dashboard order
                const ord = d => Number.isFinite(+d.order) ? +d.order : Number.MAX_SAFE_INTEGER;
                projects.sort((a, b) => ord(a) - ord(b) || String(a.id).localeCompare(String(b.id)));

                // Determine if this dashboard should be expanded
                const dashboardIdStr = String(dashboard.id);
                const shouldExpand = lastUsedDashboardId
                    ? lastUsedDashboardId === dashboardIdStr
                    : dashboardIdStr === firstDashboardId;

                // Add dashboard label (clickable for collapse/expand)
                const dashboardLabel = document.createElement('div');
                dashboardLabel.className = 'dropdown-group-label';
                if (!shouldExpand) {
                    dashboardLabel.classList.add('collapsed');
                }
                dashboardLabel.textContent = dashboard.name;
                dashboardLabel.title = "Click to expand/collapse";
                dashboardLabel.dataset.dashboardId = dashboard.id;
                scrollArea.appendChild(dashboardLabel);

                // Create collapsible container for projects
                const projectsContainer = document.createElement('div');
                projectsContainer.className = 'dashboard-projects';
                if (!shouldExpand) {
                    projectsContainer.classList.add('collapsed');
                }
                projectsContainer.dataset.dashboardId = dashboard.id;

                // Add click handler to toggle collapse
                dashboardLabel.addEventListener('click', (e) => {
                    e.stopPropagation();
                    dashboardLabel.classList.toggle('collapsed');
                    projectsContainer.classList.toggle('collapsed');
                });

                // Add projects from this dashboard
                projects.forEach(project => {
                    const projectOption = document.createElement('div');
                    projectOption.className = 'dropdown-option';
                    projectOption.textContent = project.name;
                    projectOption.dataset.value = JSON.stringify({
                        dashboardId: dashboard.id,
                        projectId: project.id
                    });

                    projectOption.addEventListener('click', async function() {
                        selectProject(this.dataset.value, this.textContent);
                    });

                    projectsContainer.appendChild(projectOption);
                });

                scrollArea.appendChild(projectsContainer);
            }
        }

        // Add new project button
        const newProjectButton = document.createElement('button');
        newProjectButton.className = 'new-project-button';
        newProjectButton.textContent = '+ New Project';
        dropdownOptions.appendChild(newProjectButton);

        // Mark last used project as selected (visually) but DON'T expand tile details
        // Quick Save button is already shown - this just pre-selects in the dropdown
        if (lastProject && lastProject.value && lastProject.name) {
            // Verify the project still exists
            const projectOption = document.querySelector(`.dropdown-option[data-value='${lastProject.value}']`);
            if (projectOption) {
                projectOption.classList.add('selected');
                selectedProjectValue = lastProject.value;
                selectedProjectName = lastProject.name;
            }
        }

        // Project modal elements
        const projectModal = document.getElementById('project-modal');
        const projectNameInput = document.getElementById('project-name-input');
        const createProjectBtn = document.getElementById('create-project');
        const dashboardSelect = document.getElementById('dashboard-select');

        // Populate dashboard select
        dashboardSelect.innerHTML = '';
        dashboards.forEach(dashboard => {
            const option = document.createElement('option');
            option.value = dashboard.id;
            option.textContent = dashboard.name;
            dashboardSelect.appendChild(option);
        });

        if (dashboards.length > 0) {
            dashboardSelect.value = dashboards[0].id;
            dashboardSelect.removeAttribute('disabled');
        }

        // Disable save button by default, enable when text is entered
        createProjectBtn.disabled = true;
        projectNameInput.addEventListener('input', () => {
            createProjectBtn.disabled = projectNameInput.value.trim() === '';
        });

        // Handle Enter key in project name input
        projectNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !createProjectBtn.disabled) {
                createProjectBtn.click();
            }
        });

        newProjectButton.addEventListener('click', () => {
            projectModal.style.display = 'flex';
            projectNameInput.value = '';
            createProjectBtn.disabled = true;
            projectNameInput.focus();
            dropdownOptions.classList.add('dropdown-hidden');
        });

        // Close modal when clicking outside
        projectModal.addEventListener('click', (e) => {
            if (e.target === projectModal) {
                projectModal.style.display = 'none';
            }
        });

        // Create new project
        createProjectBtn.addEventListener('click', async () => {
            const projectName = projectNameInput.value.trim();
            const selectedDashboardId = dashboardSelect.value;
            const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (projectName && selectedDashboardId) {
                const projectData = {
                    id: Date.now().toString(),
                    name: projectName,
                    dashboardId: selectedDashboardId
                };

                const tx = db.transaction(['projects', 'tiles'], 'readwrite');
                const projectStore = tx.objectStore('projects');
                const tileStore = tx.objectStore('tiles');

                await new Promise(resolve => {
                    const request = projectStore.add(projectData);
                    request.onsuccess = () => {
                        // Save newly created project as last used for Quick Save
                        const projectValue = JSON.stringify({
                            dashboardId: selectedDashboardId,
                            projectId: projectData.id
                        });
                        const savedProject = {
                            value: projectValue,
                            name: projectName,
                            dashboardId: selectedDashboardId
                        };
                        localStorage.setItem('lifetiles_lastProject', JSON.stringify(savedProject));
                        localStorage.setItem('lifetiles_lastDashboard', String(selectedDashboardId));

                        // Skip creating the initial tile if current tab is internal (chrome://, etc.)
                        if (!currentTab?.url || isInternalUrl(currentTab.url)) {
                          // Notify dashboard of changes
                          try {
                              const bc = new BroadcastChannel('lifetiles');
                              bc.postMessage({ type: 'tiles:changed' });
                              bc.close();
                          } catch {}
                          projectModal.style.display = 'none';
                          window.location.reload();
                          resolve();
                          return;
                        }
                        const tileData = {
                            id: Date.now().toString() + Math.random(),
                            name: currentTab.title || 'Untitled',
                            url: currentTab.url,
                            projectId: projectData.id,
                            dashboardId: selectedDashboardId
                        };
                        tileStore.add(tileData).onsuccess = () => {
                            // Notify dashboard of changes
                            try {
                                const bc = new BroadcastChannel('lifetiles');
                                bc.postMessage({ type: 'tiles:changed' });
                                bc.close();
                            } catch {}
                            projectModal.style.display = 'none';
                            window.location.reload();
                            resolve();
                        };
                    };
                });
            }
        });
    };

    // Handle save option selection
    saveCurrentOption.addEventListener('click', () => {
        saveMode = 'current';
        saveOptionsHeader.textContent = 'Save current page';
        saveOptionsList.classList.add('dropdown-hidden');
    });

    saveAllOption.addEventListener('click', () => {
        saveMode = 'all';
        saveOptionsHeader.textContent = 'Save all tabs from window';
        saveOptionsList.classList.add('dropdown-hidden');
    });

    // Input validation
    function validateInputs() {
        const nameValid = tileNameInput.value.trim() !== "";
        const urlValid = isValidUrl(tileUrlInput.value) && !isInternalUrl(tileUrlInput.value);
        const projectValid = selectedProjectValue !== "";
        saveButton.disabled = !(nameValid && urlValid && projectValid);
    }

    function isValidUrl(string) {
        try {
            new URL(string);
            return true;
        } catch (_) {
            return false;
        }
    }

    // Validate on input change
    tileNameInput.addEventListener("input", validateInputs);

    // Handle Enter key in name input
    tileNameInput.addEventListener("keydown", function(event) {
        if (event.key === 'Enter' && !saveButton.disabled) {
            saveButton.click();
        }
    });
    tileUrlInput.addEventListener("input", validateInputs);

    // Optional: press Enter in URL field to save (if valid)
    tileUrlInput.addEventListener("keydown", function (event) {
        if (event.key === 'Enter' && !saveButton.disabled) {
        saveButton.click();
        }
    });

    // Handle save button click
    saveButton.addEventListener('click', async () => {
        if (!selectedProjectValue) return;

        const { dashboardId, projectId } = JSON.parse(selectedProjectValue);

        if (saveMode === 'all') {
            const tabs = await chrome.tabs.query({ currentWindow: true });

            // Process each tab sequentially with a new transaction
            for (const tab of tabs) {
                if (!tab.url || isInternalUrl(tab.url)) continue;
                const tx = db.transaction(['tiles'], 'readwrite');
                const tileStore = tx.objectStore('tiles');

                const tileData = {
                    id: Date.now().toString() + Math.random(),
                    name: tab.title || 'Untitled',
                    url: tab.url,
                    projectId: projectId,
                    dashboardId: dashboardId
                };

                await new Promise((resolve, reject) => {
                    const request = tileStore.add(tileData);
                    request.onsuccess = resolve;
                    request.onerror = reject;
                });
            }
            // ✅ notify dashboard(s) once all writes are done
            try {
                const bc = new BroadcastChannel('lifetiles');
                bc.postMessage({ type: 'tiles:changed' });
                bc.close();
                } catch {}
                if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
                    try {
                      chrome.runtime.sendMessage({ type: 'tiles:changed' }, () => {
                        // Swallow "Could not establish connection. Receiving end does not exist."
                        void chrome.runtime.lastError;
                      });
                    } catch (_) {}
                  }
                  
            window.close();
        } else {
            const tileName = tileNameInput.value.trim();
            const tileUrl = tileUrlInput.value;

            if (tileName && isValidUrl(tileUrl) && !isInternalUrl(tileUrl)) {
                const tileData = {
                    id: Date.now().toString(),
                    name: tileName,
                    url: tileUrl,
                    projectId: projectId,
                    dashboardId: dashboardId
                };
                const tx = db.transaction(['tiles'], 'readwrite');
                const tileStore = tx.objectStore('tiles');
                const req = tileStore.add(tileData);
                req.onsuccess = () => {
                    try {
                        const bc = new BroadcastChannel('lifetiles');
                        bc.postMessage({ type: 'tiles:changed' });
                        bc.close();
                      } catch {}
                      if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
                        try {
                          chrome.runtime.sendMessage({ type: 'tiles:changed' }, () => {
                            void chrome.runtime.lastError; // swallow "Receiving end does not exist"
                          });
                        } catch (_) {}
                      }
                      window.close();
                      
                };
                req.onerror = (e) => console.error('Failed to save tile:', e);

            }
        }
    });
});

async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('lifetiles', 5);

        request.onerror = (event) => {
            reject(event.target.error);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains('dashboards')) {
                const dashboardsStore = db.createObjectStore('dashboards', { keyPath: 'id' });
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
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
    });
}