# Timeline Interactions Plan

## Feature 1: Click-to-Edit Sidebar

### Behavior
- Clicking a date bar or dot marker on the Gantt chart opens a detail sidebar panel on the right side of the timeline
- The sidebar shows:
  - **Project name** (editable inline, saves to `db.projects`)
  - **Project notes** (editable textarea, saves to `db.projects.notes`)
  - **Date label** (editable, saves to `db.projectDates.label`)
  - **Start date** (displayed, possibly editable via picker)
  - **End date** (displayed, possibly editable via picker)
  - **Space name** (read-only, for context)
- Clicking a different bar switches the sidebar content
- Clicking outside or pressing Escape closes the sidebar

### Implementation

**DOM:** Append a `.timeline-detail-sidebar` div inside `.timeline-view-container`. It slides in from the right when active.

**JS (`script.js`):**
- Add click handler to `.timeline-bar` and `.timeline-marker` elements in `renderGanttChart()`
- Each bar/marker needs `data-project-id` and `data-date-id` attributes for DB lookups
- `openTimelineDetail(projectId, dateId)` — queries project + date from DB, renders sidebar
- Inline editing uses `contentEditable` (same pattern as dashboard/project name editing)
- Notes use a `<textarea>` with auto-save on blur
- `closeTimelineDetail()` — hides sidebar

**CSS (`styles.css`):**
- `.timeline-detail-sidebar` — fixed width (~300px), right side, slide-in transition
- `.timeline-view-container.detail-open .timeline-chart` — shrinks to accommodate sidebar

### Data Flow
```
Click bar → read data-project-id, data-date-id
  → db.projects.get(projectId) → populate name, notes
  → db.projectDates.get(dateId) → populate label, start, end
Edit name → db.projects.update(projectId, { name })
Edit notes → db.projects.update(projectId, { notes })
Edit label → db.projectDates.update(dateId, { label })
```

### Changes Required
- `renderGanttChart()`: Add `data-project-id` and `data-date-id` to bar/marker HTML
- Pass `projectId` and `dateId` through the groups/rows data structure
- New functions: `openTimelineDetail()`, `closeTimelineDetail()`, `renderTimelineDetail()`
- ~120 lines JS, ~80 lines CSS

---

## Feature 2: Draggable Dates on Timeline

### Behavior
- Date bars and dot markers can be dragged horizontally on the timeline
- As you drag, the bar snaps to day columns (aligned to DAY_W grid)
- Releasing the drag updates the start/end dates in the database
- For date ranges: dragging moves the entire range (preserves duration)
- Visual feedback: bar becomes semi-transparent during drag, cursor changes to `grabbing`
- Optional: drag the left/right edge of a range bar to resize (change start or end independently)

### Implementation

**JS (`script.js`):**
- Add `mousedown` handler on `.timeline-bar` and `.timeline-marker`
- Track drag state: `{ dragging: true, dateId, startX, originalLeft, originalStartDate, originalEndDate, duration }`
- `mousemove` on `.timeline-bars`: calculate new day offset from mouse position, snap to grid
- `mouseup`: calculate new date string from final day offset, update DB
- Use `dayOffset` in reverse: `offsetToDate(dayOff)` — adds dayOff days to minDate

**Snap logic:**
```
newDayOff = Math.round((mouseX - barsRect.left + scrollLeft) / DAY_W)
newStartDate = addDays(minDate, newDayOff)
if (range): newEndDate = addDays(newStartDate, duration)
```

**DB update:**
```
await db.projectDates.update(dateId, { start: newStartDate, end: newEndDate })
```

**Edge resizing (stretch):**
- Detect if mousedown is near left or right edge of bar (within 8px)
- Left edge drag: changes start date only
- Right edge drag: changes end date only
- Cursor: `col-resize` when hovering near edges

### Changes Required
- Store `minDate` as accessible state for reverse-offset calculation
- Add `data-date-id`, `data-start`, `data-end` attributes to bars
- New functions: `initTimelineDrag()`, `handleTimelineDragMove()`, `handleTimelineDragEnd()`, `offsetToDateStr(minDate, dayOff)`
- ~150 lines JS, ~20 lines CSS

### Considerations
- Need to handle scroll during drag (if dragging near edge, auto-scroll)
- Touch support (optional, can add later)
- Undo support via `showUndoToast()` after drag completes
- Re-render bars after drag or just update the dragged element's position in-place

---

## Suggested Implementation Order
1. Feature 1 (sidebar) first — simpler, adds immediate value
2. Feature 2 (drag) second — builds on the data attributes added in Feature 1
