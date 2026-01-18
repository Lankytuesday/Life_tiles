# Lifetiles Roadmap

## Quick Wins
- [ ] Keyboard shortcuts (Alt+S to save, Alt+L to open Lifetiles)
- [ ] Duplicate detection - warn when saving existing URL
- [ ] "Open all in project" - open all tiles as tabs
- [ ] Right-click context menu - "Save to Lifetiles"

## UX Improvements
- [ ] Dark mode (follow system preference)
- [ ] Undo/redo (especially for deletes)
- [ ] Empty states with helpful prompts
- [ ] Drag tiles between projects directly (without bulk mode)
- [ ] "New Dashboard" button in popup dashboard dropdown (create dashboard without leaving popup)

## Organization
- [ ] Tags/labels - cross-project categorization
- [ ] Tile notes - optional descriptions on individual tiles
- [ ] Recently added section in popup
- [ ] Favorites/pins for important tiles

## Technical
- [ ] **Dexie.js refactor** - see DEXIE_REFACTOR.md
- [ ] Auto-backup to chrome.storage.local (debounced on change + hourly)
- [ ] Firebase backend (solves 100KB sync limit)
- [ ] Lazy loading for large dashboards
- [ ] Search within URLs, not just names

## Polish
- [ ] Onboarding/first-run tutorial
- [ ] Tile thumbnails/previews
- [ ] Animations and transitions

---

## Completed
- [x] Inline editing - double-click to edit dashboard, project, and tile names
- [x] Project notes - expandable notes field for each project
- [x] Bulk actions (move, copy, delete)
- [x] Chrome sync storage
- [x] Global search
- [x] Dashboard title display
- [x] Favicon caching
