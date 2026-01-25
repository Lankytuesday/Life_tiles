# Chrome Web Store Publishing Roadmap

## Required Before Submission

### 1. Icons
- [ ] Create `icon16.png` (16x16) - toolbar/favicon size
- [ ] Create `icon48.png` (48x48) - extensions management page
- [x] `icon128.png` (128x128) - already exists
- [ ] Update `manifest.json` to reference correct icon files

### 2. Screenshots
- [ ] Create at least 1 screenshot (1280x800 or 640x400)
- [ ] Show the main dashboard view
- [ ] Optionally: popup view, Quick Save feature, bulk actions

### 3. Privacy Policy
- [ ] Create privacy policy (see details below)
- [ ] Host it at a public URL (GitHub Pages, your website, etc.)
- [ ] Required because extension uses `tabs` permission

### 4. Store Listing Content
- [ ] Write detailed description (what it does, key features, how to use)
- [ ] Choose a category (Productivity)
- [ ] Add promotional tile images (optional but recommended):
  - Small: 440x280
  - Large: 920x680 (optional)
  - Marquee: 1400x560 (optional)

## Before Packaging

### 5. Clean Up Dev Files
Remove from the published zip:
- [ ] `.git/` folder
- [ ] `.DS_Store`
- [ ] `*.md` files (ROADMAP, etc.)
- [ ] `PopupDropdown.excalidraw`
- [ ] `test-project-order.js`
- [ ] Any other dev/test files

### 6. Final Checks
- [ ] Test extension in fresh Chrome profile
- [ ] Verify all features work
- [ ] Check for console errors
- [ ] Verify manifest.json is valid

## Submission Process

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Pay one-time $5 developer registration fee (if not already)
3. Click "New Item" and upload zip
4. Fill in store listing details
5. Add screenshots and icons
6. Submit for review (typically 1-3 days)

---

## Privacy Policy Details

Since Lifetiles uses the `tabs` permission, Google requires a privacy policy. Your policy should cover:

### What data is accessed
- Tab URLs and titles (to save as tiles)
- Stored locally in browser's IndexedDB

### What data is NOT collected
- No data sent to external servers
- No personal information collected
- No analytics or tracking

### Sample Privacy Policy Outline
1. What information the extension accesses
2. How that information is used (locally only)
3. That no data is transmitted externally
4. Contact information for questions

### Hosting Options
- GitHub Pages (free) - create a `privacy.md` in a repo
- GitHub Gist (free) - simple single-page option
- Your own website
- Notion public page
