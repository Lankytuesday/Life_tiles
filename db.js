/**
 * LinkTiles Database - Dexie.js wrapper for IndexedDB
 *
 * This file initializes the Dexie database instance used throughout the app.
 * Dexie opens the existing IndexedDB - no data migration needed.
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

// Version 7: adds color property to dashboards (no index needed)
db.version(7).stores({
    dashboards: 'id, order',
    projects: 'id, dashboardId, order',
    tiles: 'id, projectId, dashboardId, order',
    favicons: 'hostname'
});

// Data models (for reference):
// Dashboard: { id, name, order, color }
// Project: { id, dashboardId, name, order, collapsed, notes }
// Tile: { id, projectId, dashboardId, name, url, order }
// Favicon: { hostname, dataUrl, timestamp }
