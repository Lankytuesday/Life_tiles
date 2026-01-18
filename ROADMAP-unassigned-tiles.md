# Unassigned Tiles Feature Roadmap

## Overview
Add an "unassigned tiles" system that allows users to save bookmarks without immediately assigning them to a project. Two levels:
1. **Global unassigned tiles** - quick-save default, appears above dashboards in sidebar
2. **Per-dashboard unassigned tiles** - tiles assigned to a dashboard but not yet a project

---

## Design Summary

### Data Model
- One global unassigned project (`dashboardId: null` or special flag)
- One unassigned project per dashboard (auto-created, `isUnassigned: true` or similar)

### Sidebar
```
📌 Unassigned Tiles (global)    ← clickable, shows global unassigned view
─────────────────
📊 Dashboard 1  [📁]           ← folder icon replaces blue dot
📊 Dashboard 2  [📁]
   └ Project A                 ← expanded state (via folder click)
   └ Project B
```

### Main Content Area (Dashboard View)
```
┌─────────────────────────────┐
│ 📌 Unassigned Tiles (3)     │  ← dashboard's unassigned, no project header
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
│ [━━━━━━ Save ━━━━━━]        │  ← saves to global unassigned
│                             │
│ ▼ Save to project...        │
│   ▼ Dashboard 1             │
│      📌 Unassigned          │
│      📁 Project A           │
│      📁 Project B           │
│      + New Project          │
│   ▶ Dashboard 2             │
│   ─────────────────         │
│   + New Dashboard           │
└─────────────────────────────┘
```

### Drag Behavior
- Global unassigned → collapsed dashboard in sidebar = dashboard's unassigned tiles
- Global unassigned → expanded project in sidebar = that project
- Dashboard unassigned → project (within same view) = that project

---

## Phase 1: Data Model

### Schema Changes
- Add `isUnassigned: true` flag to project schema (or use reserved name like `__unassigned__`)
- Global unassigned project: `{ id: 'global-unassigned', dashboardId: null, isUnassigned: true, name: 'Unassigned Tiles' }`
- Per-dashboard unassigned: `{ id: '{dashboardId}-unassigned', dashboardId: '{id}', isUnassigned: true, name: 'Unassigned Tiles' }`

### Auto-creation
- Create global unassigned project on first run (if not exists)
- Create per-dashboard unassigned project when dashboard is created
- Migration: create unassigned projects for existing dashboards

---

## Phase 2: Main Page UI - Sidebar

### Sidebar Redesign
```
📌 Unassigned Tiles (global)    ← clickable, shows global unassigned view
─────────────────
📊 Dashboard 1  [📁]           ← folder icon replaces blue dot
📊 Dashboard 2  [📁]
   └ Project A                 ← expanded state (via folder click)
   └ Project B
```

### Implementation
- [ ] Add "Unassigned Tiles" section above dashboard list
- [ ] Replace selected indicator (blue dot) with folder icon
- [ ] Folder icon click → toggle inline project list
- [ ] Click dashboard name → load dashboard (existing behavior)
- [ ] Style expanded projects with indent

---

## Phase 3: Main Page UI - Content Area

### Global Unassigned View
When "Unassigned Tiles" clicked in sidebar:
- Flat grid of tiles, no project structure
- No project headers or collapse controls
- Drag tiles to sidebar dashboards/projects to organize

### Dashboard View with Unassigned Section
```
┌─────────────────────────────┐
│ 📌 Unassigned Tiles (3)     │  ← subtle header, not collapsible
│ [tile] [tile] [tile]        │
├─────────────────────────────┤
│ ▼ Project A                 │  ← normal project rendering
│   [tile] [tile]             │
└─────────────────────────────┘
```

### Implementation
- [ ] New view mode for global unassigned tiles
- [ ] Render dashboard unassigned tiles above projects
- [ ] Hide unassigned section if empty (or show placeholder?)
- [ ] Unassigned tiles should be draggable to projects below

---

## Phase 4: Drag and Drop

### Drag Behaviors
| From | To | Result |
|------|-----|--------|
| Global unassigned tile | Collapsed dashboard in sidebar | → Dashboard's unassigned tiles |
| Global unassigned tile | Expanded project in sidebar | → That project |
| Global unassigned tile | Project in content area | → That project |
| Dashboard unassigned tile | Project in same dashboard | → That project |

### Implementation
- [ ] Enable drag from global unassigned view to sidebar
- [ ] Detect drop target (dashboard vs project)
- [ ] Update tile's `projectId` accordingly
- [ ] Visual feedback during drag (highlight valid targets)

---

## Phase 5: Popup Redesign

### New Layout
```
┌─────────────────────────────┐
│ [━━━━━━ Save ━━━━━━]        │  ← saves to global unassigned
│                             │
│ ▼ Save to project...        │
│   ▼ Dashboard 1             │
│      📌 Unassigned          │
│      📁 Project A           │
│      📁 Project B           │
│      + New Project          │
│   ▶ Dashboard 2             │
│   ─────────────────         │
│   + New Dashboard           │
└─────────────────────────────┘
```

### Implementation
- [ ] Top "Save" button → saves to global unassigned project
- [ ] Collapsible dashboard tree with projects
- [ ] Each dashboard shows its unassigned option + projects
- [ ] "+ New Project" inside each dashboard
- [ ] "+ New Dashboard" at bottom
- [ ] Remove old project dropdown UI

---

## Phase 6: Polish & Edge Cases

- [ ] Empty states (no unassigned tiles messaging)
- [ ] Bulk operations on unassigned tiles
- [ ] Search includes unassigned tiles
- [ ] Keyboard navigation in new popup
- [ ] Animation for drag feedback
- [ ] Sync unassigned tile counts in sidebar badges?

---

## Implementation Order

1. **Data model** - schema + auto-creation (foundation)
2. **Dashboard unassigned section** - render unassigned above projects (visible progress)
3. **Sidebar unassigned section** - global unassigned clickable area
4. **Global unassigned view** - flat grid when clicked
5. **Sidebar folder expansion** - show projects inline
6. **Drag to organize** - drag unassigned → dashboard/project
7. **Popup redesign** - new save flow

---

## Questions to Resolve

- Should empty unassigned sections be hidden or show a placeholder?
- Badge/count for unassigned tiles in sidebar?
- Limit on unassigned tiles before prompting to organize?
- Should global unassigned tiles be synced across devices differently?

---

## Notes

- Keep existing tile schema, only add `isUnassigned` to projects
- Unassigned projects are hidden from normal project lists
- Consider feature flag for gradual rollout
