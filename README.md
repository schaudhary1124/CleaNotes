# CleaNotes

CleaNotes is a local-first desktop note app built with Tauri, React, and TypeScript. It combines a structured notes browser, a rich Markdown editor, sketch annotations, study cards, and multi-window support in one focused workspace.

## Download

**[Download CleaNotes →](https://schaudhary1124.github.io/CleaNotes/)**

Prebuilt installers for macOS, Windows, and Linux are published on the [Releases page](https://github.com/schaudhary1124/CleaNotes/releases/latest) and linked from the download page above. Once installed, CleaNotes checks for new releases in the background and can update itself in place — no re-downloading required.

Builds aren't code-signed yet, so first launch may show an "unidentified developer" (macOS) or "unrecognized app" (Windows) warning — see the download page for how to get past it.

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

## Building from source

For development, or if you'd rather not use the prebuilt installers above:

```bash
npm install
npm run tauri dev
```

To build the app:

```bash
npm run build
```

## Releasing

`scripts/release.sh` (or `npm run release`) cuts a full release in one shot: it bumps the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`, commits and pushes to `main`, pushes a matching `vX.Y.Z` tag to kick off the GitHub Actions build for macOS/Windows/Linux, watches the build to completion, and publishes the resulting GitHub release. Installed copies of CleaNotes and the [download page](https://schaudhary1124.github.io/CleaNotes/) both pick up published releases automatically - nothing else to update by hand.

One-time setup:

```bash
brew install gh
gh auth login
```

To release, from a clean `main` that's already pushed with everything you want to ship:

```bash
npm run release            # prompts for the new version
npm run release 0.3.0      # or pass it directly
```

The script refuses to run with a dirty working tree, on a branch other than `main`, or if `main` is behind `origin/main` - fix those first. It asks for confirmation once (showing the version-bump diff) before pushing or tagging anything.

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/) with [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
