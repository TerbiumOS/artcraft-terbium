# Artcraft Terbium Ports

This repository packages browser-ready Storytold Craft applications as Terbium Application Packages (`.tapp.zip`). It intentionally does not attempt to port the native `storytold/artcraft` desktop app or backend services: only projects with dedicated WASM/browser targets can run in a Terbium webview.

## Included sources

- `pdfcraft`
- `photocraft`
- `vectorcraft`
- `lightcraft`
- `wordcraft`
- `deckcraft`
- `gridcraft`
- `filmcraft`

The source repositories are cloned into `sources/` at build time rather than added as submodules. This keeps upstream tracking automatic and avoids committing multi-repository source snapshots.

## Requirements

- Node.js 20+
- Rust stable with `wasm32-unknown-unknown`
- Trunk 0.21.14 for PdfCraft, PhotoCraft, VectorCraft, WordCraft, DeckCraft, and GridCraft
- Rust 1.95.0 for the current upstream web builds
- `wasm-bindgen-cli` matching the version pinned in LightCraft and FilmCraft's `Cargo.lock` (currently 0.2.129)
- `wasm-opt` (Binaryen) for optimized bundles; the build supports optional omission locally
- Any project-specific Rust prerequisites documented upstream
- Windows users: `tar` is used to create ZIP archives. Current Windows installations include BSdtar.

`node-linker=hoisted` is set in `.npmrc` for this exFAT workspace. The packaging script itself has no Node dependencies.

## Build

```sh
npm run build
```

Build one port:

```sh
npm run build -- pdfcraft
```

Artifacts are written to `dist/*.tapp.zip`. Every archive contains `.tbconfig`, app entry HTML, static web assets, and an icon directly at the ZIP root, as required by Terbium Package Manager.

The build injects `scripts/tfsbridge-adapter.js` as `terbium-tfs.js` into every TAPP. It mirrors `localStorage` under `/home/{current-user}/.config/artcraft-terbium/{app-id}/`, exposes `window.artcraftTfs`, redirects supported file pickers and blob downloads to Terbium dialogs/TFS, and captures Ctrl/Cmd+S. TFS writes pass exact binary buffers and are size-verified. App-owned library/project databases that upstream persists in IndexedDB/OPFS remain in those browser stores.

## Automation

`.github/workflows/update-and-package.yml` runs every Monday at 03:17 UTC and can also be launched manually. It pulls the configured upstream branches, runs `scripts/package-apps.mjs` for the selected web targets, and replaces the `rolling-latest` GitHub release with the generated TAPPs. This workflow only removes and recreates its own `rolling-latest` release/tag; separately tagged releases remain untouched.

The rolling release is marked as the latest GitHub release. Stable/LTS releases can use separate tags and are not modified by this workflow.

## Terbium packaging contract

The generated packages follow Terbium v2's documented TAPP layout:

- A `.tapp` package has `.tbconfig` at archive root and points to the packaged app entry page.
- The archive is named `{app}.tapp.zip`.
- The installed package's `.tbconfig` is at archive root and owns window configuration; an app-repository entry should use `pkg-download` and omit `wmArgs`.

## Constraints

The Trunk apps emit their site to `sources/<app>/dist/web`. LightCraft is built from its repository root with `cargo xtask web` and emits to `target/web-site`; FilmCraft uses the same command and emits to `target/web/dist`.

The apps use browser technologies such as WebAssembly, WebGPU/WebGL, storage APIs, workers, and in some cases media APIs. Successful packaging does not guarantee every capability is available in every Terbium host browser. Validate each package in the intended Terbium deployment before publishing it as supported.
