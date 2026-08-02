#!/usr/bin/env node
// Post-build guard for the browser-guest bundle (see vite.browser-guest.config.ts). The
// browser-guest entry only ever imports joinSession from src/collab/yjsBridge.ts, never
// hostSession - but that file's top also unconditionally imports acl.ts (-> fsNotes.ts's
// @tauri-apps/plugin-fs), milkdown/headlessParse.ts (-> milkdown/setup.ts ->
// noteLinkClick.ts's @tauri-apps/plugin-opener), and identity.ts (-> @tauri-apps/api/core),
// all solely for hostSession. None of those modules have top-level side effects, so Rollup's
// dead-code elimination *should* drop them from the shipped bundle since hostSession itself is
// never referenced - but "should, probably" isn't a real guarantee for a constraint this
// explicit, especially for files under active development. This scans the actual built output
// and fails loudly if any Tauri marker survived, instead of shipping a page that silently
// breaks (or worse, silently no-ops) the moment it runs outside a Tauri webview.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "docs/edit";
const FORBIDDEN_PATTERNS = [/@tauri-apps/, /__TAURI__/, /__TAURI_INTERNALS__/, /tauri:\/\//];

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectJsFiles(full));
    } else if (entry.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

let files;
try {
  files = collectJsFiles(OUT_DIR);
} catch (err) {
  console.error(`Couldn't read ${OUT_DIR} - did the build actually run first? (${err.message})`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No .js files found under ${OUT_DIR} - did the build actually run?`);
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const pattern of FORBIDDEN_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      console.error(`✗ ${file}: found "${match[0]}" - this bundle must never depend on Tauri APIs.`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("\nbrowser-guest bundle failed the Tauri-isolation check - see the comment at the top of this script.");
  process.exit(1);
}

console.log(`✓ ${files.length} file(s) under ${OUT_DIR} are free of Tauri markers.`);
