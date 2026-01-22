/**
 * Lifetiles Background Service Worker
 * Handles keyboard shortcuts and other background tasks
 */

console.log('Lifetiles background script starting...');

// Import Dexie for IndexedDB access
try {
    importScripts('dexie.min.js');
    console.log('Dexie loaded successfully');
} catch (e) {
    console.error('Failed to load Dexie:', e);
}

// Initialize database (same schema as db.js)
const db = new Dexie('lifetiles');
db.version(6).stores({
    dashboards: 'id, order',
    projects: 'id, dashboardId, order',
    tiles: 'id, projectId, dashboardId, order',
    favicons: 'hostname'
});

const GLOBAL_UNASSIGNED_ID = 'global-unassigned';

/**
 * Generate a unique ID for new tiles
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Save the current tab to Quick Save (global unassigned)
 */
async function saveCurrentTab() {
    try {
        // Get the active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab || !tab.url) {
            console.error('No active tab found');
            return;
        }

        // Skip chrome:// and other restricted URLs
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
            console.log('Cannot save browser internal pages');
            return;
        }

        // Ensure the global unassigned project exists
        const globalUnassigned = await db.projects.get(GLOBAL_UNASSIGNED_ID);
        if (!globalUnassigned) {
            await db.projects.add({
                id: GLOBAL_UNASSIGNED_ID,
                dashboardId: null,
                name: 'Quick Save',
                order: -1
            });
        }

        // Get current tile count for ordering
        const existingTiles = await db.tiles.where('projectId').equals(GLOBAL_UNASSIGNED_ID).toArray();
        const nextOrder = existingTiles.length;

        // Create the new tile
        const newTile = {
            id: generateId(),
            projectId: GLOBAL_UNASSIGNED_ID,
            dashboardId: null,
            name: tab.title || 'Untitled',
            url: tab.url,
            order: nextOrder
        };

        await db.tiles.add(newTile);

        console.log('Saved tab to Quick Save:', newTile.name);

        // Notify any open Lifetiles pages to refresh (uses existing live update system)
        chrome.runtime.sendMessage({ type: 'tiles:changed' }).catch(() => {
            // Ignore errors if no listeners (popup/page not open)
        });

        // Also broadcast for BroadcastChannel listeners
        try {
            const bc = new BroadcastChannel('lifetiles');
            bc.postMessage({ type: 'tiles:changed' });
            bc.close();
        } catch (e) {
            // BroadcastChannel not available
        }

        // Optional: Show a badge or notification
        chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });

        // Clear badge after 1.5 seconds
        setTimeout(() => {
            chrome.action.setBadgeText({ text: '', tabId: tab.id });
        }, 1500);

    } catch (error) {
        console.error('Error saving tab:', error);
    }
}

// Listen for keyboard shortcut commands
chrome.commands.onCommand.addListener((command) => {
    if (command === 'save-current-tab') {
        saveCurrentTab();
    }
});
