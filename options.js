async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('lifetiles', 5);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            if (!db.objectStoreNames.contains('dashboards')) {
                db.createObjectStore('dashboards', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('projects')) {
                const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
                projectStore.createIndex('dashboardId', 'dashboardId');
            }
            if (!db.objectStoreNames.contains('tiles')) {
                const tileStore = db.createObjectStore('tiles', { keyPath: 'id' });
                tileStore.createIndex('projectId', 'projectId');
                tileStore.createIndex('dashboardId', 'dashboardId');
            }
            if (!db.objectStoreNames.contains('favicons')) {
                db.createObjectStore('favicons', { keyPath: 'hostname' });
            }
        };
    });
}

document.addEventListener('DOMContentLoaded', function() {
    const toggle = document.getElementById('default-new-tab');
    const importBtn = document.getElementById('import-bookmarks');
    const exportBtn = document.getElementById('export-data');
    const importDataBtn = document.getElementById('import-data');
    const importFile = document.getElementById('import-file');
    const status = document.getElementById('status');

    exportBtn.addEventListener('click', async function() {
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
    });

    importDataBtn.addEventListener('click', function() {
        importFile.click();
    });

    importFile.addEventListener('change', async function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async function(e) {
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
    });

    function showStatus(message) {
        const status = document.getElementById('status');
        status.textContent = message;
        status.style.display = 'block';
        requestAnimationFrame(() => {
            status.style.opacity = '1';
            setTimeout(() => {
                status.style.opacity = '0';
                setTimeout(() => {
                    status.style.display = 'none';
                }, 300);
            }, 3000);
        });
    }

    function processBookmarksBar(bookmarkBar) {
        const projects = [];
        const looseBookmarks = {
            id: crypto.randomUUID(),
            name: 'Imported Bookmarks',
            tiles: []
        };

        bookmarkBar.children.forEach(child => {
            if (child.url) {
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
                    if (bookmark.url) {
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

    importBtn.addEventListener('click', function() {
        // Create and show dashboard selection modal
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            background: white;
            padding: 20px;
            border-radius: 8px;
            min-width: 300px;
        `;

        content.innerHTML = `
            <h3 style="margin-top: 0;">Select Dashboard</h3>
            <select id="dashboard-select" style="width: 100%; padding: 8px; margin: 10px 0;">
            </select>
            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
                <button id="cancel-import" style="padding: 8px 16px;">Cancel</button>
                <button id="confirm-import" style="padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 4px;">Import</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        // Populate dashboard select using IndexedDB
        initDB().then(db => {
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
        }).catch(error => {
            console.error('Error loading dashboards:', error);
        });

        // Handle cancel
        document.getElementById('cancel-import').onclick = () => {
            document.body.removeChild(modal);
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

                    document.body.removeChild(modal);
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
    });

    // Check if Chrome APIs are available
    if (typeof chrome !== 'undefined' && chrome.storage) {
        // Load saved settings
        chrome.storage.sync.get(['defaultNewTab'], function(result) {
            toggle.checked = result.defaultNewTab || false;
        });

    // Save settings when changed
    toggle.addEventListener('change', function() {
        chrome.storage.sync.set({
            defaultNewTab: toggle.checked
        }, function() {
            status.textContent = 'Settings saved!';
            status.style.opacity = '1';
            setTimeout(() => {
                status.style.opacity = '0';
            }, 2000);
        });
    });
    } else {
        console.error('Chrome APIs not available');
        status.textContent = 'Error: Could not access Chrome settings';
        status.style.opacity = '1';
        toggle.disabled = true;
    }
});