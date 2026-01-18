/**
 * Lifetiles Database - Dexie.js wrapper for IndexedDB
 *
 * This file initializes the Dexie database instance used throughout the app.
 * Dexie opens the existing 'LifetilesDB' IndexedDB - no data migration needed.
 */

// Initialize Dexie database (same name as existing IndexedDB)
const db = new Dexie('lifetiles');

// Define schema - matches existing IndexedDB structure
// Only indexed fields need to be listed (id is always primary key)
db.version(6).stores({
    dashboards: 'id, order',
    projects: 'id, dashboardId, order',
    tiles: 'id, projectId, dashboardId, order',
    favicons: 'hostname'
});

// Data models (for reference):
// Dashboard: { id, name, order }
// Project: { id, dashboardId, name, order, collapsed, notes }
// Tile: { id, projectId, dashboardId, name, url, order }
// Favicon: { hostname, dataUrl, timestamp }
