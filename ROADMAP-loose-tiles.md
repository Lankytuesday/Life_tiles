# Loose Tiles Feature Roadmap

## Overview
Add a "loose tiles" system that allows users to save bookmarks without immediately assigning them to a project. Two levels:
1. **Global loose tiles** - quick-save default, appears above dashboards in sidebar
2. **Per-dashboard loose tiles** - tiles assigned to a dashboard but not yet a project

---

## Design Summary

### Data Model
- One global loose project (`dashboardId: null` or special flag)
- One loose project per dashboard (auto-created, `isLoose: true` or similar)

### Sidebar
```
📌 Loose Tiles (global)        ← clickable, shows global loose view
─────────────────
📊 Dashboard 1  [📁]           ← folder icon replaces blue dot
📊 Dashboard 2  [📁]
   └ Project A                 ← expanded state (via folder click)
   └ Project B
```

### Main Content Area (Dashboard View)
```
┌─────────────────────────────┐
│ 📌 Loose Tiles (3)          │  ← dashboard's loose, no project header
│ [tile] [tile] [tile]        │
├─────────────────────────────┤
│ ▼ Project A                 │
│   [tile] [tile]             │
│ ▼ Project B                 │
│   [tile]                    │
└─────────────────────────────┘
```

### Popup
```
┌─────────────────────────────┐
│ [━━━━━━ Save ━━━━━━]        │  ← saves to global loose
│                             │
│ ▼ Save to project...        │
│   ▼ Dashboard 1             │
│      📌 Loose               │
│      📁 Project A           │
│      📁 Project B           │
│      + New Project          │
│   ▶ Dashboard 2             │
│   ─────────────────         │
│   + New Dashboard           │
└─────────────────────────────┘
```

### Drag Behavior
- Global loose → collapsed dashboard in sidebar = dashboard's loose tiles
- Global loose → expanded project in sidebar = that project
- Dashboard loose → project (within same view) = that project

---

## Phase 1: Data Model

### Schema Changes
- Add `isLoose: true` flag to project schema (or use reserved name like `__loose__`)
- Global loose project: `{ id: 'global-loose', dashboardId: null, isLoose: true, name: 'Loose Tiles' }`
- Per-dashboard loose: `{ id: '{dashboardId}-loose', dashboardId: '{id}', isLoose: true, name: 'Loose Tiles' }`

### Auto-creation
- Create global loose project on first run (if not exists)
- Create per-dashboard loose project when dashboard is created
- Migration: create loose projects for existing dashboards

---

## Phase 2: Main Page UI - Sidebar

### Sidebar Redesign
```
📌 Loose Tiles (global)        ← clickable, shows global loose view
─────────────────
📊 Dashboard 1  [📁]           ← folder icon replaces blue dot
📊 Dashboard 2  [📁]
   └ Project A                 ← expanded state (via folder click)
   └ Project B
```

### Implementation
- [ ] Add "Loose Tiles" section above dashboard list
- [ ] Replace selected indicator (blue dot) with folder icon
- [ ] Folder icon click → toggle inline project list
- [ ] Click dashboard name → load dashboard (existing behavior)
- [ ] Style expanded projects with indent

---

## Phase 3: Main Page UI - Content Area

### Global Loose View
When "Loose Tiles" clicked in sidebar:
- Flat grid of tiles, no project structure
- No project headers or collapse controls
- Drag tiles to sidebar dashboards/projects to organize

### Dashboard View with Loose Section
```
┌─────────────────────────────┐
│ 📌 Loose Tiles (3)          │  ← subtle header, not collapsible
│ [tile] [tile] [tile]        │
├─────────────────────────────┤
│ ▼ Project A                 │  ← normal project rendering
│   [tile] [tile]             │
└─────────────────────────────┘
```

### Implementation
- [ ] New view mode for global loose tiles
- [ ] Render dashboard loose tiles above projects
- [ ] Hide loose section if empty (or show placeholder?)
- [ ] Loose tiles should be draggable to projects below

---

## Phase 4: Drag and Drop

### Drag Behaviors
| From | To | Result |
|------|-----|--------|
| Global loose tile | Collapsed dashboard in sidebar | → Dashboard's loose tiles |
| Global loose tile | Expanded project in sidebar | → That project |
| Global loose tile | Project in content area | → That project |
| Dashboard loose tile | Project in same dashboard | → That project |

### Implementation
- [ ] Enable drag from global loose view to sidebar
- [ ] Detect drop target (dashboard vs project)
- [ ] Update tile's `projectId` accordingly
- [ ] Visual feedback during drag (highlight valid targets)

---

## Phase 5: Popup Redesign

### New Layout
```
┌─────────────────────────────┐
│ [━━━━━━ Save ━━━━━━]        │  ← saves to global loose
│                             │
│ ▼ Save to project...        │
│   ▼ Dashboard 1             │
│      📌 Loose               │
│      📁 Project A           │
│      📁 Project B           │
│      + New Project          │
│   ▶ Dashboard 2             │
│   ─────────────────         │
│   + New Dashboard           │
└─────────────────────────────┘
```

### Implementation
- [ ] Top "Save" button → saves to global loose project
- [ ] Collapsible dashboard tree with projects
- [ ] Each dashboard shows its loose option + projects
- [ ] "+ New Project" inside each dashboard
- [ ] "+ New Dashboard" at bottom
- [ ] Remove old project dropdown UI

---

## Phase 6: Polish & Edge Cases

- [ ] Empty states (no loose tiles messaging)
- [ ] Bulk operations on loose tiles
- [ ] Search includes loose tiles
- [ ] Keyboard navigation in new popup
- [ ] Animation for drag feedback
- [ ] Sync loose tile counts in sidebar badges?

---

## Implementation Order

1. **Data model** - schema + auto-creation (foundation)
2. **Dashboard loose section** - render loose above projects (visible progress)
3. **Sidebar loose section** - global loose clickable area
4. **Global loose view** - flat grid when clicked
5. **Sidebar folder expansion** - show projects inline
6. **Drag to organize** - drag loose → dashboard/project
7. **Popup redesign** - new save flow

---

## Questions to Resolve

- Should empty loose sections be hidden or show a placeholder?
- Badge/count for loose tiles in sidebar?
- Limit on loose tiles before prompting to organize?
- Should global loose tiles be synced across devices differently?

---

## Notes

- Keep existing tile schema, only add `isLoose` to projects
- Loose projects are hidden from normal project lists
- Consider feature flag for gradual rollout
