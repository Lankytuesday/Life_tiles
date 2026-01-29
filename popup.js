/**
 * LinkTiles Popup - Redesigned to match quick-save modal aesthetic
 */

const GLOBAL_UNASSIGNED_ID = 'global-unassigned';

// Track state
let selectedProjectId = null;
let selectedDashboardId = null;
let saveMode = 'current'; // 'current' or 'all'
let currentTab = null;

// Helpers - only allow http/https to prevent javascript:/data: execution
function isInternalUrl(u) {
    try {
        const url = new URL(u);
        return url.protocol !== 'http:' && url.protocol !== 'https:';
    } catch { return true; }
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// HTML escape utility to prevent XSS
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Get the last-focused normal Chrome window id (not the popup)
async function getTargetWindowId() {
    try {
        const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
        if (w && typeof w.id === 'number') return w.id;
    } catch (_) {}
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    return wins[0]?.id ?? null;
}

// Focus existing dashboard tab in that window, or create it there
async function focusOrCreateDashboardInWindow(windowId) {
    const dashboardUrl = chrome.runtime.getURL('index.html');
    const matches = await chrome.tabs.query({
        windowId,
        url: [dashboardUrl, `${dashboardUrl}*`]
    });

    if (matches.length) {
        matches.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
        await chrome.tabs.update(matches[0].id, { active: true });
        await chrome.windows.update(windowId, { focused: true });
    } else {
        await chrome.tabs.create({ windowId, url: dashboardUrl, active: true });
    }
}

// Notify other LinkTiles pages of changes
function notifyChanges() {
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
        } catch {}
    }
}

// Get next order for a project
async function getNextProjectOrder(dashboardId) {
    const existingProjects = await db.projects.where('dashboardId').equals(dashboardId).toArray();
    let maxOrder = -1;
    existingProjects.forEach(p => {
        const order = Number.isFinite(+p.order) ? +p.order : -1;
        if (order > maxOrder) maxOrder = order;
    });
    return maxOrder + 1;
}

// Get next order for a tile in a project
async function getNextTileOrder(projectId) {
    const existingTiles = await db.tiles.where('projectId').equals(projectId).toArray();
    return existingTiles.length;
}

// DOM Ready
document.addEventListener('DOMContentLoaded', async function() {
    // Get current tab info
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    // Elements
    const dashboardLink = document.getElementById('dashboard-link');
    const quickSaveTabBtn = document.getElementById('quick-save-tab-btn');
    const quickSaveAllBtn = document.getElementById('quick-save-all-btn');
    const projectTree = document.getElementById('project-tree');
    const tileDetails = document.getElementById('tile-details');
    const tileNameInput = document.getElementById('tile-name-input');
    const tileUrlInput = document.getElementById('tile-url-input');
    const tileUrlDisplay = document.getElementById('tile-url-display');
    const saveCurrentBtn = document.getElementById('save-current-btn');
    const saveAllBtn = document.getElementById('save-all-btn');
    const saveButton = document.getElementById('save-button');

    // Project Modal elements
    const projectModal = document.getElementById('project-modal');
    const modalDashboardSelect = document.getElementById('modal-dashboard-select');
    const projectNameInput = document.getElementById('project-name-input');
    const modalCancel = document.getElementById('modal-cancel');
    const createProjectBtn = document.getElementById('create-project-btn');
    const modalSaveCurrent = document.getElementById('modal-save-current');
    const modalSaveAll = document.getElementById('modal-save-all');

    // Dashboard Modal elements
    const dashboardModal = document.getElementById('dashboard-modal');
    const dashboardNameInput = document.getElementById('dashboard-name-input');
    const dashboardModalCancel = document.getElementById('dashboard-modal-cancel');
    const createDashboardBtn = document.getElementById('create-dashboard-btn');
    const dashboardSaveCurrent = document.getElementById('dashboard-save-current');
    const dashboardSaveAll = document.getElementById('dashboard-save-all');

    let modalSaveMode = 'current';
    let dashboardModalSaveMode = 'current';

    // Pre-populate tile info
    if (currentTab && currentTab.url && !isInternalUrl(currentTab.url)) {
        tileNameInput.value = currentTab.title || '';
        tileUrlInput.value = currentTab.url || '';
        tileUrlDisplay.textContent = currentTab.url || '';
    }

    // Dashboard link handler
    dashboardLink.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            const windowId = await getTargetWindowId();
            if (windowId == null) {
                await chrome.windows.create({ url: chrome.runtime.getURL('index.html') });
            } else {
                await focusOrCreateDashboardInWindow(windowId);
            }
        } catch (err) {
            console.error('Go to dashboard failed:', err);
        } finally {
            window.close();
        }
    });

    // Quick Save tab button
    quickSaveTabBtn.addEventListener('click', async () => {
        if (!currentTab || !currentTab.url || isInternalUrl(currentTab.url)) {
            console.log('Cannot save this tab');
            return;
        }

        const tileData = {
            id: generateId(),
            name: currentTab.title || 'Untitled',
            url: currentTab.url,
            projectId: GLOBAL_UNASSIGNED_ID,
            dashboardId: null,
            order: await getNextTileOrder(GLOBAL_UNASSIGNED_ID)
        };
        await db.tiles.add(tileData);
        notifyChanges();
        window.close();
    });

    // Quick Save all tabs button
    quickSaveAllBtn.addEventListener('click', async () => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        let order = await getNextTileOrder(GLOBAL_UNASSIGNED_ID);

        for (const tab of tabs) {
            if (!tab.url || isInternalUrl(tab.url)) continue;
            const tileData = {
                id: generateId(),
                name: tab.title || 'Untitled',
                url: tab.url,
                projectId: GLOBAL_UNASSIGNED_ID,
                dashboardId: null,
                order: order++
            };
            await db.tiles.add(tileData);
        }

        notifyChanges();
        window.close();
    });

    // Save mode toggle
    saveCurrentBtn.addEventListener('click', () => {
        saveMode = 'current';
        saveCurrentBtn.classList.add('active');
        saveAllBtn.classList.remove('active');
    });

    saveAllBtn.addEventListener('click', () => {
        saveMode = 'all';
        saveAllBtn.classList.add('active');
        saveCurrentBtn.classList.remove('active');
    });

    // Modal save mode toggle
    modalSaveCurrent.addEventListener('click', () => {
        modalSaveMode = 'current';
        modalSaveCurrent.classList.add('active');
        modalSaveAll.classList.remove('active');
    });

    modalSaveAll.addEventListener('click', () => {
        modalSaveMode = 'all';
        modalSaveAll.classList.add('active');
        modalSaveCurrent.classList.remove('active');
    });

    // Validate save button
    function validateSaveButton() {
        const nameValid = tileNameInput.value.trim() !== '';
        const projectValid = selectedProjectId !== null;
        saveButton.disabled = !(nameValid && projectValid);
    }

    tileNameInput.addEventListener('input', validateSaveButton);

    // Enter key to save
    tileNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !saveButton.disabled) {
            saveButton.click();
        }
    });

    // Save button click
    saveButton.addEventListener('click', async () => {
        if (!selectedProjectId) return;

        if (saveMode === 'all') {
            const tabs = await chrome.tabs.query({ currentWindow: true });
            let order = await getNextTileOrder(selectedProjectId);

            for (const tab of tabs) {
                if (!tab.url || isInternalUrl(tab.url)) continue;
                const tileData = {
                    id: generateId(),
                    name: tab.title || 'Untitled',
                    url: tab.url,
                    projectId: selectedProjectId,
                    dashboardId: selectedDashboardId,
                    order: order++
                };
                await db.tiles.add(tileData);
            }
        } else {
            const tileName = tileNameInput.value.trim() || 'Untitled';
            const tileData = {
                id: generateId(),
                name: tileName,
                url: currentTab.url,
                projectId: selectedProjectId,
                dashboardId: selectedDashboardId,
                order: await getNextTileOrder(selectedProjectId)
            };
            await db.tiles.add(tileData);
        }

        // Save last used project
        localStorage.setItem('lifetiles_lastProject', JSON.stringify({
            projectId: selectedProjectId,
            dashboardId: selectedDashboardId
        }));
        localStorage.setItem('lifetiles_lastDashboard', String(selectedDashboardId));

        notifyChanges();
        window.close();
    });

    // Select a project
    function selectProject(projectId, dashboardId, element) {
        // Clear previous selection
        document.querySelectorAll('.project-item.selected').forEach(el => el.classList.remove('selected'));

        // Set new selection
        element.classList.add('selected');
        selectedProjectId = projectId;
        selectedDashboardId = dashboardId;

        // Show tile details
        tileDetails.classList.remove('hidden');
        validateSaveButton();
        tileNameInput.focus();
    }

    // Render project tree
    async function renderProjectTree() {
        projectTree.innerHTML = '';

        // Load dashboards
        const dashboards = await db.dashboards.toArray();
        dashboards.sort((a, b) => {
            const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
            const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
            return ao - bo;
        });

        // Render each dashboard with its projects
        for (const dashboard of dashboards) {
            const group = document.createElement('div');
            group.className = 'dashboard-group';

            // Dashboard header - all spaces start collapsed
            const header = document.createElement('div');
            header.className = 'dashboard-header collapsed';

            header.innerHTML = `
                <svg class="dashboard-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
                <svg class="dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="7" height="7"></rect>
                    <rect x="14" y="3" width="7" height="7"></rect>
                    <rect x="14" y="14" width="7" height="7"></rect>
                    <rect x="3" y="14" width="7" height="7"></rect>
                </svg>
                <span class="dashboard-name">${escapeHtml(dashboard.name)}</span>
            `;

            // Projects list - starts collapsed
            const projectsList = document.createElement('div');
            projectsList.className = 'projects-list collapsed';

            // Load projects for this dashboard
            const projects = await db.projects
                .where('dashboardId')
                .equals(dashboard.id)
                .toArray();

            // Separate unassigned and regular projects
            const unassignedProject = projects.find(p => p.isUnassigned);
            const regularProjects = projects.filter(p => !p.isUnassigned);
            regularProjects.sort((a, b) => {
                const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
                const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
                return ao - bo;
            });

            // Add unassigned project first if it exists
            if (unassignedProject) {
                const item = document.createElement('div');
                item.className = 'project-item';
                item.innerHTML = `
                    <svg class="project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
                        <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
                    </svg>
                    <span class="project-name">Unsorted</span>
                `;
                item.addEventListener('click', () => selectProject(unassignedProject.id, dashboard.id, item));
                projectsList.appendChild(item);
            }

            // Add regular projects
            for (const project of regularProjects) {
                const item = document.createElement('div');
                item.className = 'project-item';
                item.innerHTML = `
                    <svg class="project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <span class="project-name">${escapeHtml(project.name)}</span>
                `;
                item.addEventListener('click', () => selectProject(project.id, dashboard.id, item));
                projectsList.appendChild(item);
            }

            // Add "New Project" item
            const newProjectItem = document.createElement('div');
            newProjectItem.className = 'project-item new-project-item';
            newProjectItem.innerHTML = `
                <svg class="project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span class="project-name">New Project</span>
            `;
            newProjectItem.addEventListener('click', () => {
                modalDashboardSelect.value = dashboard.id;
                projectModal.classList.remove('hidden');
                projectNameInput.value = '';
                createProjectBtn.disabled = true;
                projectNameInput.focus();
            });
            projectsList.appendChild(newProjectItem);

            // Toggle collapse on header click
            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
                projectsList.classList.toggle('collapsed');
            });

            group.appendChild(header);
            group.appendChild(projectsList);
            projectTree.appendChild(group);

            // Add dashboard to modal select
            const option = document.createElement('option');
            option.value = dashboard.id;
            option.textContent = dashboard.name;
            modalDashboardSelect.appendChild(option);
        }

        // Add "New Space" item at bottom of tree
        const newDashboardItem = document.createElement('div');
        newDashboardItem.className = 'dashboard-group new-dashboard-item';
        newDashboardItem.innerHTML = `
            <div class="dashboard-header new-dashboard-header">
                <svg class="dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span class="dashboard-name">New Space</span>
            </div>
        `;
        newDashboardItem.addEventListener('click', () => {
            dashboardModal.classList.remove('hidden');
            dashboardNameInput.value = '';
            createDashboardBtn.disabled = true;
            dashboardNameInput.focus();
        });
        projectTree.appendChild(newDashboardItem);
    }

    // Modal handlers
    modalCancel.addEventListener('click', () => {
        projectModal.classList.add('hidden');
    });

    projectModal.addEventListener('click', (e) => {
        if (e.target === projectModal) {
            projectModal.classList.add('hidden');
        }
    });

    projectNameInput.addEventListener('input', () => {
        createProjectBtn.disabled = projectNameInput.value.trim() === '';
    });

    projectNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !createProjectBtn.disabled) {
            createProjectBtn.click();
        }
    });

    createProjectBtn.addEventListener('click', async () => {
        const projectName = projectNameInput.value.trim();
        const dashboardId = modalDashboardSelect.value;
        if (!projectName || !dashboardId) return;

        const nextOrder = await getNextProjectOrder(dashboardId);

        const projectData = {
            id: generateId(),
            name: projectName,
            dashboardId: dashboardId,
            order: nextOrder
        };

        await db.projects.add(projectData);

        // Save tiles
        if (modalSaveMode === 'all') {
            const tabs = await chrome.tabs.query({ currentWindow: true });
            let order = 0;
            for (const tab of tabs) {
                if (!tab.url || isInternalUrl(tab.url)) continue;
                const tileData = {
                    id: generateId(),
                    name: tab.title || 'Untitled',
                    url: tab.url,
                    projectId: projectData.id,
                    dashboardId: dashboardId,
                    order: order++
                };
                await db.tiles.add(tileData);
            }
        } else {
            if (currentTab && currentTab.url && !isInternalUrl(currentTab.url)) {
                const tileData = {
                    id: generateId(),
                    name: currentTab.title || 'Untitled',
                    url: currentTab.url,
                    projectId: projectData.id,
                    dashboardId: dashboardId,
                    order: 0
                };
                await db.tiles.add(tileData);
            }
        }

        // Save as last used
        localStorage.setItem('lifetiles_lastProject', JSON.stringify({
            projectId: projectData.id,
            dashboardId: dashboardId
        }));
        localStorage.setItem('lifetiles_lastDashboard', String(dashboardId));

        notifyChanges();
        window.close();
    });

    // Dashboard modal handlers
    dashboardModalCancel.addEventListener('click', () => {
        dashboardModal.classList.add('hidden');
    });

    dashboardModal.addEventListener('click', (e) => {
        if (e.target === dashboardModal) {
            dashboardModal.classList.add('hidden');
        }
    });

    dashboardNameInput.addEventListener('input', () => {
        createDashboardBtn.disabled = dashboardNameInput.value.trim() === '';
    });

    dashboardNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !createDashboardBtn.disabled) {
            createDashboardBtn.click();
        }
    });

    // Dashboard save mode toggle
    dashboardSaveCurrent.addEventListener('click', () => {
        dashboardModalSaveMode = 'current';
        dashboardSaveCurrent.classList.add('active');
        dashboardSaveAll.classList.remove('active');
    });

    dashboardSaveAll.addEventListener('click', () => {
        dashboardModalSaveMode = 'all';
        dashboardSaveAll.classList.add('active');
        dashboardSaveCurrent.classList.remove('active');
    });

    createDashboardBtn.addEventListener('click', async () => {
        const dashboardName = dashboardNameInput.value.trim();
        if (!dashboardName) return;

        // Get next order for dashboard
        const dashboards = await db.dashboards.toArray();
        const maxOrder = dashboards.reduce((max, d) => Math.max(max, d.order ?? 0), -1);

        const dashboardData = {
            id: generateId(),
            name: dashboardName,
            order: maxOrder + 1
        };

        await db.dashboards.add(dashboardData);

        // Create unassigned project for this dashboard
        const unassignedId = `${dashboardData.id}-unassigned`;
        await db.projects.add({
            id: unassignedId,
            dashboardId: dashboardData.id,
            name: 'Unsorted',
            isUnassigned: true,
            order: -1
        });

        // Save tiles to the unassigned project
        if (dashboardModalSaveMode === 'all') {
            const tabs = await chrome.tabs.query({ currentWindow: true });
            let order = 0;
            for (const tab of tabs) {
                if (!tab.url || isInternalUrl(tab.url)) continue;
                const tileData = {
                    id: generateId(),
                    name: tab.title || 'Untitled',
                    url: tab.url,
                    projectId: unassignedId,
                    dashboardId: dashboardData.id,
                    order: order++
                };
                await db.tiles.add(tileData);
            }
        } else {
            if (currentTab && currentTab.url && !isInternalUrl(currentTab.url)) {
                const tileData = {
                    id: generateId(),
                    name: currentTab.title || 'Untitled',
                    url: currentTab.url,
                    projectId: unassignedId,
                    dashboardId: dashboardData.id,
                    order: 0
                };
                await db.tiles.add(tileData);
            }
        }

        // Save as last used
        localStorage.setItem('lifetiles_lastDashboard', String(dashboardData.id));

        notifyChanges();
        window.close();
    });

    // Keyboard shortcut - Escape to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!projectModal.classList.contains('hidden')) {
                projectModal.classList.add('hidden');
            }
            if (!dashboardModal.classList.contains('hidden')) {
                dashboardModal.classList.add('hidden');
            }
        }
    });

    // Render the project tree
    await renderProjectTree();
});
