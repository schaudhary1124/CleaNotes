# CleaNotes

CleaNotes is a local-first desktop note app built with Tauri, React, and TypeScript. It combines a structured notes browser, a rich Markdown editor, sketch annotations, study cards, and multi-window support in one focused workspace.

## What it does

CleaNotes is designed for people who want one app for writing, organizing, and reviewing notes without giving up flexibility. You can create folders, nest notes, search across your content, rename and move entries with drag and drop, and open notes in separate windows when you want a wider workspace.

The editor supports rich formatting through Milkdown, along with note-level sketching and annotations. Notes can also switch into study mode, where CleaNotes turns compatible Markdown lines into flashcards or multiple-choice questions for quick review.

## Key features

- Local-first desktop note taking with Tauri
- Folder-based note organization
- Global search across notes
- Rich Markdown editing with formatting tools
- Sketch mode for drawing directly on notes
- Study mode with flashcards and multiple-choice review
- Multi-window note duplication and window mirroring
- Autosave and cross-window note sync
- Customizable theme, accent, background, and toolbar settings
- Window controls, always-on-top mode, and a polished desktop shell

## Study syntax

CleaNotes recognizes simple study-item lines inside Markdown notes:

```md
Q: What is the capital of France? -> A: Paris
MCQ: Which planet is known as the Red Planet? | Mercury, Venus, Mars, Jupiter | Mars
```

In study mode, flashcards and multiple-choice items are extracted from the note and shown one at a time for review.

## Tech stack

- Tauri 2
- React 19
- TypeScript
- Vite
- Milkdown
- CodeMirror

## Getting started

Install dependencies and run the app locally:

```bash
npm install
npm run tauri dev
```

To build the app:

```bash
npm run build
```

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/) with [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
