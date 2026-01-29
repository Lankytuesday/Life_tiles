/**
 * LinkTiles Quick Save Popup - Save current tab to a specific project
 */

// Initialize Dexie database (same schema as main app)
const db = new Dexie('lifetiles');
db.version(6).stores({
    dashboards: 'id, order',
    projects: 'id, dashboardId, order',
    tiles: 'id, projectId, dashboardId, order',
    favicons: 'hostname'
});

const GLOBAL_UNASSIGNED_ID = 'global-unassigned';

let selectedProjectId = GLOBAL_UNASSIGNED_ID;
let tabInfo = null;

/**
 * Generate unique ID
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * HTML escape utility to prevent XSS
 */
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Get tab info from URL parameters (passed by background script)
 */
function getTabInfoFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return {
        title: params.get('title') || 'Untitled',
        url: params.get('url') || '',
        favIconUrl: params.get('favicon') || ''
    };
}

/**
 * Initialize the popup
 */
async function init() {
    // Get tab info from URL params
    tabInfo = getTabInfoFromUrl();

    // Populate page info
    document.getElementById('page-title').value = tabInfo.title;
    document.getElementById('page-url').textContent = tabInfo.url;

    const favicon = document.getElementById('page-favicon');
    if (tabInfo.favIconUrl) {
        favicon.src = tabInfo.favIconUrl;
        favicon.onerror = () => {
            favicon.style.display = 'none';
        };
    } else {
        favicon.style.display = 'none';
    }

    // Load and render project tree
    await renderProjectTree();

    // Set up event listeners
    document.getElementById('save-btn').addEventListener('click', handleSave);
    document.getElementById('cancel-btn').addEventListener('click', () => window.close());

    // Project modal handlers
    const projectModal = document.getElementById('project-modal');
    const modalDashboardSelect = document.getElementById('modal-dashboard-select');
    const projectNameInput = document.getElementById('project-name-input');
    const projectCancel = document.getElementById('project-cancel');
    const projectCreate = document.getElementById('project-create');

    projectCancel.addEventListener('click', () => {
        projectModal.classList.add('hidden');
    });

    projectModal.addEventListener('click', (e) => {
        if (e.target === projectModal) {
            projectModal.classList.add('hidden');
        }
    });

    projectNameInput.addEventListener('input', () => {
        projectCreate.disabled = projectNameInput.value.trim() === '';
    });

    projectNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !projectCreate.disabled) {
            projectCreate.click();
        }
    });

    projectCreate.addEventListener('click', async () => {
        const projectName = projectNameInput.value.trim();
        const dashboardId = modalDashboardSelect.value;
        if (!projectName || !dashboardId) return;

        // Get next order for project
        const existingProjects = await db.projects.where('dashboardId').equals(dashboardId).toArray();
        let maxOrder = -1;
        existingProjects.forEach(p => {
            const order = Number.isFinite(+p.order) ? +p.order : -1;
            if (order > maxOrder) maxOrder = order;
        });

        const projectData = {
            id: generateId(),
            name: projectName,
            dashboardId: dashboardId,
            order: maxOrder + 1
        };

        await db.projects.add(projectData);

        // Save the tile to the new project
        const title = document.getElementById('page-title').value.trim() || 'Untitled';
        const newTile = {
            id: generateId(),
            projectId: projectData.id,
            dashboardId: dashboardId,
            name: title,
            url: tabInfo.url,
            order: 0
        };

        await db.tiles.add(newTile);

        // Notify other LinkTiles pages
        chrome.runtime.sendMessage({ type: 'tiles:changed' }).catch(() => {});
        try {
            const bc = new BroadcastChannel('lifetiles');
            bc.postMessage({ type: 'tiles:changed' });
            bc.close();
        } catch (e) {}

        window.close();
    });

    // Dashboard modal handlers
    const dashboardModal = document.getElementById('dashboard-modal');
    const dashboardNameInput = document.getElementById('dashboard-name-input');
    const dashboardCancel = document.getElementById('dashboard-cancel');
    const dashboardCreate = document.getElementById('dashboard-create');

    dashboardCancel.addEventListener('click', () => {
        dashboardModal.classList.add('hidden');
    });

    dashboardModal.addEventListener('click', (e) => {
        if (e.target === dashboardModal) {
            dashboardModal.classList.add('hidden');
        }
    });

    dashboardNameInput.addEventListener('input', () => {
        dashboardCreate.disabled = dashboardNameInput.value.trim() === '';
    });

    dashboardNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !dashboardCreate.disabled) {
            dashboardCreate.click();
        }
    });

    dashboardCreate.addEventListener('click', async () => {
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

        // Save the tile to the unassigned project
        const title = document.getElementById('page-title').value.trim() || 'Untitled';
        const newTile = {
            id: generateId(),
            projectId: unassignedId,
            dashboardId: dashboardData.id,
            name: title,
            url: tabInfo.url,
            order: 0
        };

        await db.tiles.add(newTile);

        // Notify other LinkTiles pages
        chrome.runtime.sendMessage({ type: 'tiles:changed' }).catch(() => {});
        try {
            const bc = new BroadcastChannel('lifetiles');
            bc.postMessage({ type: 'tiles:changed' });
            bc.close();
        } catch (e) {}

        window.close();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!projectModal.classList.contains('hidden')) {
                projectModal.classList.add('hidden');
            } else if (!dashboardModal.classList.contains('hidden')) {
                dashboardModal.classList.add('hidden');
            } else {
                window.close();
            }
        } else if (e.key === 'Enter' &&
                   projectModal.classList.contains('hidden') &&
                   dashboardModal.classList.contains('hidden')) {
            // Save on Enter (only if no modal is open)
            e.preventDefault();
            handleSave();
        }
    });
}

/**
 * Render the dashboard/project tree
 */
async function renderProjectTree() {
    const tree = document.getElementById('project-tree');
    const modalDashboardSelect = document.getElementById('modal-dashboard-select');
    tree.innerHTML = '';
    modalDashboardSelect.innerHTML = '';

    // Add Quick Save option at top
    const quickSaveItem = document.createElement('div');
    quickSaveItem.className = 'quick-save-item selected';
    quickSaveItem.dataset.projectId = GLOBAL_UNASSIGNED_ID;
    quickSaveItem.innerHTML = `
        <svg class="project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
            <polyline points="13 2 13 9 20 9"></polyline>
        </svg>
        <span class="project-name">Quick Save</span>
    `;
    quickSaveItem.addEventListener('click', () => selectProject(GLOBAL_UNASSIGNED_ID, quickSaveItem));
    tree.appendChild(quickSaveItem);

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
            const unassignedItem = document.createElement('div');
            unassignedItem.className = 'project-item';
            unassignedItem.dataset.projectId = unassignedProject.id;
            unassignedItem.innerHTML = `
                <svg class="project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
                    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
                </svg>
                <span class="project-name">Unsorted</span>
            `;
            unassignedItem.addEventListener('click', () => selectProject(unassignedProject.id, unassignedItem));
            projectsList.appendChild(unassignedItem);
        }

        for (const project of regularProjects) {
            const item = document.createElement('div');
            item.className = 'project-item';
            item.dataset.projectId = project.id;
            item.innerHTML = `
                <svg class="project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
                <span class="project-name">${escapeHtml(project.name)}</span>
            `;
            item.addEventListener('click', () => selectProject(project.id, item));
            projectsList.appendChild(item);
        }

        // Add "New Project" item at end of projects list
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
            document.getElementById('project-modal').classList.remove('hidden');
            document.getElementById('project-name-input').value = '';
            document.getElementById('project-create').disabled = true;
            document.getElementById('project-name-input').focus();
        });
        projectsList.appendChild(newProjectItem);

        // Toggle collapse on header click
        header.addEventListener('click', () => {
            header.classList.toggle('collapsed');
            projectsList.classList.toggle('collapsed');
        });

        group.appendChild(header);
        group.appendChild(projectsList);
        tree.appendChild(group);

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
        const modal = document.getElementById('dashboard-modal');
        const input = document.getElementById('dashboard-name-input');
        modal.classList.remove('hidden');
        input.value = '';
        document.getElementById('dashboard-create').disabled = true;
        input.focus();
    });
    tree.appendChild(newDashboardItem);
}

/**
 * Select a project
 */
function selectProject(projectId, element) {
    // Clear previous selection
    document.querySelectorAll('.quick-save-item.selected, .project-item.selected, .dashboard-header.selected')
        .forEach(el => el.classList.remove('selected'));

    // Set new selection
    element.classList.add('selected');
    selectedProjectId = projectId;
}

/**
 * Handle save button click
 */
async function handleSave() {
    const saveBtn = document.getElementById('save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        const title = document.getElementById('page-title').value.trim() || 'Untitled';

        // Get current tile count for ordering
        const existingTiles = await db.tiles.where('projectId').equals(selectedProjectId).toArray();
        const nextOrder = existingTiles.length;

        // Create the tile
        const newTile = {
            id: generateId(),
            projectId: selectedProjectId,
            dashboardId: null,
            name: title,
            url: tabInfo.url,
            order: nextOrder
        };

        await db.tiles.add(newTile);

        // Notify other LinkTiles pages
        chrome.runtime.sendMessage({ type: 'tiles:changed' }).catch(() => {});
        try {
            const bc = new BroadcastChannel('lifetiles');
            bc.postMessage({ type: 'tiles:changed' });
            bc.close();
        } catch (e) {}

        // Close the window
        window.close();

    } catch (error) {
        console.error('Error saving tile:', error);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        alert('Failed to save. Please try again.');
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
