import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// A second, independent build target for the browser-guest page (see docs/edit/ and
// src/browser-guest/) - a minimal, install-free page for editing exactly one shared note
// directly in a browser tab. Deliberately its own config rather than a second entry bolted onto
// vite.config.ts: this one needs a different build.outDir (it publishes straight into the
// existing GitHub Pages site under docs/edit/) and must never run through `tauri dev`/
// `tauri build`, so keeping the two configs fully separate avoids ever needing an "is this the
// Tauri build or not" branch inside a single shared config. No `server.port`/`strictPort` here
// (unlike vite.config.ts, which pins 1420 for Tauri's sake) - `vite dev` just uses its own
// default (5173), which is what's allow-listed in workers/turn-credentials for local dev.
//
// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // GitHub Pages serves this repo under /CleaNotes/ (a project page, not a custom domain), and
  // this build lands a level deeper at docs/edit/ - without an explicit base, Vite defaults to
  // "/" and emits asset references like /assets/foo.js, which resolve to the wrong place
  // (domain root) on a nested deployment and load nothing, silently, leaving a blank page. The
  // main vite.config.ts never needs this: Tauri's webview serves dist/ as its own root, not a
  // nested path on a real host.
  base: "/CleaNotes/edit/",
  build: {
    outDir: "docs/edit",
    rollupOptions: {
      // Named browser-guest.html (not index.html) purely so it sits unambiguously next to
      // index.html at the repo root - Vite always names the built HTML after its source file,
      // so `npm run build:browser-guest` renames the output to docs/edit/index.html afterward
      // (see package.json), which is what actually needs to be there for
      // https://schaudhary1124.github.io/CleaNotes/edit/ to serve it. Running `vite build`
      // directly against this config (skipping the npm script) skips that rename.
      input: "browser-guest.html",
    },
  },
});
