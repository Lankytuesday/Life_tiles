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
  
      // Options page link (unchanged)
      document.getElementById('options-link').addEventListener('click', () => {
          chrome.tabs.create({
              url: chrome.runtime.getURL('options.html')
          });
      });

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

    // Track selected project value and save mode
    let selectedProjectValue = '';
    let saveMode = 'current'; // 'current' or 'all'

    // Initially hide tile details and disable save button
    tileDetails.style.display = 'none';
    saveButton.disabled = true;

    // Initialize IndexedDB
    const db = await initDB();

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

    // Load all projects from all dashboards into dropdown
    const tx = db.transaction(['dashboards', 'projects'], 'readonly');
    const dashboardStore = tx.objectStore('dashboards');
    const projectStore = tx.objectStore('projects');

    const dashboardsRequest = dashboardStore.getAll();
    dashboardsRequest.onsuccess = async () => {
        let dashboards = dashboardsRequest.result;

        // Sort dashboards by order property
        if (dashboards && dashboards.length > 0) {
            dashboards.sort((a, b) => (a.order || 0) - (b.order || 0));
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

        // Create groups for each dashboard
        for (const dashboard of dashboards) {
            const projectsRequest = projectStore.index('dashboardId').getAll(dashboard.id);
            const projects = await new Promise(resolve => {
                projectsRequest.onsuccess = () => resolve(projectsRequest.result);
            });

            if (projects.length > 0) {
                // Add dashboard label
                const dashboardLabel = document.createElement('div');
                dashboardLabel.className = 'dropdown-group-label';
                dashboardLabel.textContent = dashboard.name;
                dashboardLabel.title = "Dashboard";
                scrollArea.appendChild(dashboardLabel);

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
                        document.querySelectorAll('.dropdown-option').forEach(opt => {
                            opt.classList.remove('selected');
                        });
                        this.classList.add('selected');
                        dropdownHeader.textContent = this.textContent;
                        selectedProjectValue = this.dataset.value;
                        dropdownOptions.classList.add('dropdown-hidden');

                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        tileNameInput.value = tab.title || '';
                        tileUrlInput.value = tab.url || '';
                        tileDetails.style.display = 'block';
                        validateInputs();
                        tileNameInput.focus();
                    });

                    scrollArea.appendChild(projectOption);
                });
            }
        }

        // Add new project button
        const newProjectButton = document.createElement('button');
        newProjectButton.className = 'new-project-button';
        newProjectButton.textContent = '+ New Project';
        dropdownOptions.appendChild(newProjectButton);

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

        // Show/hide create button based on input
        projectNameInput.addEventListener('input', () => {
            const hasValue = projectNameInput.value.trim() !== '';
            createProjectBtn.style.display = hasValue ? 'flex' : 'none';
        });

        newProjectButton.addEventListener('click', () => {
            projectModal.style.display = 'flex';
            projectNameInput.value = '';
            createProjectBtn.style.display = 'none';
            projectNameInput.focus();
            dropdownOptions.classList.add('dropdown-hidden');
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
                        const tileData = {
                            id: Date.now().toString() + Math.random(),
                            name: currentTab.title || 'Untitled',
                            url: currentTab.url,
                            projectId: projectData.id,
                            dashboardId: selectedDashboardId
                        };
                        tileStore.add(tileData).onsuccess = () => {
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
        const urlValid = isValidUrl(tileUrlInput.value);
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

    // Handle save button click
    saveButton.addEventListener('click', async () => {
        if (!selectedProjectValue) return;

        const { dashboardId, projectId } = JSON.parse(selectedProjectValue);

        if (saveMode === 'all') {
            const tabs = await chrome.tabs.query({ currentWindow: true });

            // Process each tab sequentially with a new transaction
            for (const tab of tabs) {
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

            window.close();
        } else {
            const tileName = tileNameInput.value.trim();
            const tileUrl = tileUrlInput.value;

            if (tileName && isValidUrl(tileUrl)) {
                const tileData = {
                    id: Date.now().toString(),
                    name: tileName,
                    url: tileUrl,
                    projectId: projectId,
                    dashboardId: dashboardId
                };
                const tx = db.transaction(['tiles'], 'readwrite');
                const tileStore = tx.objectStore('tiles');
                tileStore.add(tileData).onsuccess = () => window.close();
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