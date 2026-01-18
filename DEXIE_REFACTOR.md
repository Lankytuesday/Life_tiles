# Dexie.js Migration Plan

## Overview
Refactor from raw IndexedDB API to Dexie.js for cleaner, more maintainable database code.

**Branch:** `refactor/dexie-migration`

---

## Current State
- **Database:** `LifetilesDB` (IndexedDB)
- **Stores:** dashboards, projects, tiles, favicons
- **Files affected:** script.js (~58 DB calls), popup.js (~10 DB calls)
- **Pain points:** Manual Promise wrapping, verbose transaction handling, repetitive boilerplate

---

## Schema Design

```javascript
import Dexie from 'dexie';

export const db = new Dexie('LifetilesDB');

db.version(1).stores({
  dashboards: 'id, order',
  projects: 'id, dashboardId, order',
  tiles: 'id, projectId, dashboardId, order',
  favicons: 'hostname'
});
```

### Data Models
| Store | Fields |
|-------|--------|
| dashboards | id, name, order |
| projects | id, dashboardId, name, order, collapsed, notes |
| tiles | id, projectId, dashboardId, name, url, order |
| favicons | hostname, dataUrl, timestamp |

---

## Migration Steps

### Phase 1: Setup
- [ ] Create feature branch `refactor/dexie-migration`
- [ ] Add Dexie.js to project (via CDN or local file)
- [ ] Create `db.js` with schema definition
- [ ] Verify Dexie can open existing IndexedDB data (same DB name)

### Phase 2: Refactor script.js
- [ ] Replace `initDB()` calls with Dexie imports
- [ ] Migrate dashboard operations
  - [ ] `loadDashboards()` / `getAllDashboards()`
  - [ ] `saveDashboard()` / create dashboard
  - [ ] `updateDashboard()` / rename
  - [ ] `deleteDashboard()`
  - [ ] `updateDashboardOrder()`
- [ ] Migrate project operations
  - [ ] `loadProjectsForDashboard()`
  - [ ] `saveProject()` / create project
  - [ ] `updateProject()` / rename, notes, collapsed state
  - [ ] `deleteProject()`
  - [ ] `moveProjectToDashboard()`
  - [ ] `updateProjectOrder()`
- [ ] Migrate tile operations
  - [ ] `loadTilesForProject()`
  - [ ] `saveTile()` / create tile
  - [ ] `updateTile()` / edit name/url
  - [ ] `deleteTile()`
  - [ ] `moveTileToProject()`
  - [ ] `copyTileToProject()`
  - [ ] `updateTileOrder()`
- [ ] Migrate favicon cache operations
  - [ ] `checkFaviconCache()`
  - [ ] `cacheFavicon()`

### Phase 3: Refactor popup.js
- [ ] Import shared Dexie instance
- [ ] Migrate dashboard loading
- [ ] Migrate project loading
- [ ] Migrate tile saving (quick save from popup)

### Phase 4: Cleanup & Technical Debt
- [ ] Remove old `initDB()` function
- [ ] Remove manual Promise wrappers
- [ ] Remove unused transaction code
- [ ] Update any error handling
- [ ] Audit for redundant/inefficient code patterns:
  - [ ] Elements being dynamically created unnecessarily
  - [ ] Duplicate code that can be consolidated
  - [ ] Unused variables or functions
  - [ ] Inefficient DOM queries (repeated lookups)
  - [ ] Any legacy workarounds that are no longer needed

### Phase 5: Testing
- [ ] Test dashboard CRUD
- [ ] Test project CRUD (including notes)
- [ ] Test tile CRUD
- [ ] Test drag-and-drop reordering
- [ ] Test bulk operations (move, copy, delete)
- [ ] Test search functionality
- [ ] Test popup quick-save
- [ ] Test favicon caching
- [ ] Test data persistence across browser restart

### Phase 6: Merge
- [ ] Squash merge to master
- [ ] Delete feature branch
- [ ] Update ROADMAP.md

---

## Code Patterns

### Before (Raw IndexedDB)
```javascript
async function getTile(id) {
    const db = await initDB();
    const tx = db.transaction(['tiles'], 'readonly');
    const store = tx.objectStore('tiles');
    return new Promise((resolve, reject) => {
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
```

### After (Dexie)
```javascript
async function getTile(id) {
    return db.tiles.get(id);
}
```

### Common Dexie Operations
```javascript
// Get all
db.dashboards.toArray()

// Get by key
db.tiles.get(id)

// Get by index
db.projects.where('dashboardId').equals(id).toArray()

// Add
db.tiles.add({ id, name, url, projectId, dashboardId })

// Update
db.tiles.update(id, { name: newName })

// Delete
db.tiles.delete(id)

// Bulk delete
db.tiles.where('projectId').equals(id).delete()

// Count
db.tiles.where('projectId').equals(id).count()
```

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Data loss during migration | Dexie opens existing IndexedDB - no migration needed |
| Breaking existing functionality | Incremental commits, thorough testing |
| Bundle size increase | Dexie is ~25KB gzipped - acceptable |
| Browser compatibility | Dexie supports all browsers that support IndexedDB |

---

## Rollback Plan
If issues arise:
```bash
git checkout master
git reset --hard origin/master
```
Feature branch preserves working state until merge.

---

## Success Criteria
- [ ] All existing features work identically
- [ ] No data loss
- [ ] Code is significantly cleaner and shorter
- [ ] All tests pass (manual testing checklist above)
