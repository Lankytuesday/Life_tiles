// Entry file for esbuild — re-exports TipTap modules as a single IIFE bundle.
// Run: npx esbuild tiptap-entry.js --bundle --format=iife --global-name=TipTap --minify --outfile=../tiptap.bundle.js

export { Editor, Extension } from '@tiptap/core';
export { default as StarterKit } from '@tiptap/starter-kit';
export { default as TaskList } from '@tiptap/extension-task-list';
export { default as TaskItem } from '@tiptap/extension-task-item';
export { default as Placeholder } from '@tiptap/extension-placeholder';
