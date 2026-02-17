# Add TipTap Rich Text Editor for Project Notes

## Context
The checklist-notes feature branch attempted inline checklists using per-line `contentEditable` spans, but cross-line text selection doesn't work — each line is a separate `contentEditable` element and the browser won't let you drag-select across them. User testing confirmed this is a dealbreaker. TipTap (built on ProseMirror) handles this natively.

## Key Decision: No Full Build Pipeline
TipTap has no pre-built UMD file, and Chrome Extension CSP blocks CDN scripts. The solution is a **one-time esbuild step** that produces a vendored `tiptap.bundle.js` — committed to the repo just like `dexie.min.js` and `Sortable.min.js`. Day-to-day development stays build-free. You only re-run esbuild if you upgrade TipTap or add extensions.

## Phase 1: Build the vendored bundle

**Create `build/` directory** (development-only, not part of the extension):

1. `build/package.json` — npm deps for the one-time build
2. `build/tiptap-entry.js` — ~10 line entry file that imports and re-exports TipTap modules:
   - `@tiptap/core` (Editor)
   - `@tiptap/starter-kit` (paragraphs, lists, undo/redo, etc.)
   - `@tiptap/extension-task-list` (checklist container)
   - `@tiptap/extension-task-item` (checklist items with checkboxes)
   - `@tiptap/extension-placeholder` (empty editor hint text)
3. Run: `cd build && npm install && npx esbuild tiptap-entry.js --bundle --format=iife --global-name=TipTap --minify --outfile=../tiptap.bundle.js`
4. Add `build/node_modules/` to `.gitignore`
5. Commit `tiptap.bundle.js` (~200-300KB, comparable to existing vendored libs)

## Phase 2: Wire up the bundle

**`index.html`** — Add one script tag (between `dexie.min.js` and `db.js`):
```html
<script src="tiptap.bundle.js"></script>
```

**`db.js`** — No changes needed. The `notes` field stays a string (now HTML instead of plain text). No schema version bump.

## Phase 3: Core editor functions

**`script.js`** — Add near the top (after `escapeHtml`):

1. **`migrateNotesToHtml(notes)`** — Lazy migration from plain text to HTML. Checks if string starts with `<` (already HTML) or converts line-by-line: `- [x] text` → task list HTML, `• text` → bullet list HTML, plain text → `<p>` tags. Also handles the checklist-notes branch format. Runs on read, saved back on next auto-save.

2. **`tiptapEditors` Map** — Keyed by project ID. Tracks all active editor instances.

3. **`destroyAllEditors()`** — Iterates the map, calls `editor.destroy()`, clears the map. Called before `projectsList.innerHTML = ''` in `loadDashboards()` and `__lifetilesRefresh` to prevent memory leaks.

4. **`createEditorForProject(container, projectId, htmlContent)`** — Creates a TipTap Editor instance with:
   - StarterKit (heading, codeBlock, blockquote, horizontalRule disabled — keep it simple)
   - TaskList + TaskItem (checklists)
   - Placeholder ("Add notes...")
   - `onUpdate` callback that debounce-saves to Dexie

5. **`debouncedSaveNotes(projectId, html)`** — Debounced (300ms) save of `editor.getHTML()` to `db.projects.update(projectId, { notes: html })`.

## Phase 4: Replace the textarea

**`script.js` in `createProjectElement()` (~lines 2338-2390):**

- Replace `notesTextarea` element with a container `div` (class `notes-editor-container`)
- Add a **toolbar** above the editor with two icon buttons: bullet list toggle and checklist toggle
- **Lazy initialization**: Editor is created on first expand of the notes section (not on project render). This avoids creating dozens of unused editors.
- Toggle click handlers call `editor.chain().focus().toggleBulletList().run()` and `editor.chain().focus().toggleTaskList().run()`
- Remove the old blur-save listener (replaced by `onUpdate` debounced save)
- On notes collapse (outside click or toggle), destroy the editor and remove from map

## Phase 5: Styling

**`styles.css`:**

- Remove `.project-notes-textarea` rules (~lines 661-684)
- Add TipTap editor styles (~70 lines):
  - `.tiptap` container — min-height, max-height, overflow-y, padding, border, focus ring
  - `ul[data-type="taskList"]` — no list-style, flex layout for checkbox + text
  - `li[data-checked="true"]` — strikethrough + muted color
  - Bullet list normalization
  - Placeholder pseudo-element
- Add `.notes-toolbar` styles — small icon buttons matching existing UI patterns
- Increase `.project-notes-section.expanded` max-height to accommodate richer content

## Files Modified
1. **`build/package.json`** — new (dev-only npm deps)
2. **`build/tiptap-entry.js`** — new (~10 lines, esbuild entry)
3. **`tiptap.bundle.js`** — new (vendored output, ~200-300KB)
4. **`index.html`** — add one script tag
5. **`script.js`** — add editor functions at top (~80 lines), modify `createProjectElement` (~+40/-25 lines), add `destroyAllEditors()` call in `loadDashboards()`
6. **`styles.css`** — replace textarea styles with TipTap styles (~+70/-20 lines)
7. **`.gitignore`** — add `build/node_modules/`

## What Happens to feature/checklist-notes
The branch becomes obsolete — TipTap replaces the hand-rolled per-line editor entirely. The `parseNotesLines`/`serializeNotesLines` utilities and `createNotesLine` function are no longer needed. The migration function handles any data saved in that format.

## Verification
1. Open a project with existing plain text notes → auto-migrated, displays correctly
2. Type text, create bullet list (toolbar button), create checklist (toolbar button)
3. Check/uncheck checklist items → strikethrough toggles, auto-saves
4. **Select text across multiple lines with cursor** → works (the whole point)
5. Multiple notes panels open simultaneously → each has independent editor
6. Switch spaces / trigger refresh → editors destroyed and recreated cleanly, no memory leak
7. Export → notes field contains HTML. Import old backup with plain text → migrates on display.
8. Load extension in Chrome → no CSP errors, bundle loads correctly
