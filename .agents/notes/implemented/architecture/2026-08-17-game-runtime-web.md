# Agent Note: A web engine backend over the project's own Vite (M6)

Status: implemented

English | [中文](2026-08-17-game-runtime-web.zh.md)

## Problem

The game seam's only backend is Godot, but the primary consumers of this fork build web games (Vite-shaped npm projects: PixiJS, Phaser, plain canvas). They need the same registry surface — build, run, read logs, query scenes/assets, capture frames — without a native engine binary, and without the provider acquiring a browser-automation dependency tree (Playwright, puppeteer) that the harness would then own.

## Decision

**The engine binary is the project's own local Vite.** Builds and preview runs spawn `node <project>/node_modules/vite/bin/vite.js build|preview --port N --strictPort` through `ctx.subprocess`. This deliberately avoids package-manager CLIs: on Windows, npm/pnpm shims are `.cmd` files that modern Node refuses to spawn without a shell, and the failure mode is a broken provider on the platform the consumers develop on. A project without a local Vite fails every build/run with `GAME_EXECUTABLE_MISSING` — the same honest contract Godot has with its engine binary.

**Frame capture is the browser CLI, not a driver library.** The shipped `assets/web-serve.mjs` probe (the web analogue of Godot's `.gd` probes) serves the build output on an ephemeral loopback port and prints one `WEB_SERVE_URL <origin>` line; the provider polls for it, then spawns the configured Chromium-family browser with `--headless --disable-gpu --hide-scrollbars --window-size=WxH --screenshot=<path> <origin>/<scenePath>`, tears the server down, validates the PNG magic + IHDR chunk, and reports the pixel size read from the file itself. No driver dependency, shim-able in tests exactly like the Godot shim, and the `browserArgvPrefix`/`browserExtraArgs` config keeps wrapper shapes and warm-up budgets (`--virtual-time-budget`) declarative.

**Scene/asset queries are text heuristics, matching the Godot backend's honesty.** An HTML document parses into a `Document` root with script/stylesheet/identified-element children (declared markup only, never runtime DOM); assets classify by extension into the shared kind vocabulary with an `export class X extends Y` header for modules. `exportPreset` is rejected outright — the build script and Vite modes own the artifact — rather than silently ignored.

## Testing

`packages/game/game-runtime-web/tests/web-runtime.spec.ts` (19 tests) drives the real runtime through the real subprocess seam: spec-resolution shapes (run/build argv, defaults, rejections), real builds through a fake project-local Vite entry (exit-zero result, non-zero-exit result, missing-Vite `GAME_EXECUTABLE_MISSING`), live preview process lifecycle (log marker, terminate, exited state), HTML scene parsing and its failure code, asset classification/header/missing/escape cases, and captures through the REAL serve probe plus a browser shim (1x1 PNG magic bytes, relative-path resolution, browser-failure and no-build-output branches, empty-path rejection), plus the plugin wiring (registers under `web`, resolvable through the registry).

## Alternatives considered

**Spawn `npm run build`.** The idiomatic npm gesture, but it resolves to `.cmd` shims on Windows that Node cannot spawn directly; wrapping in `cmd.exe /c` drags quoting rules into the spec. Rejected: driving `node vite.js` is shell-free and cross-platform.

**Playwright/puppeteer for capture (and later input).** Richer control (waiting for selectors, CDP input), and the natural M4 implementation base — but it makes the harness own a browser-download dependency graph per deployment. Rejected for M6: the CLI screenshot covers the observation loop; M4 can revisit a driver seam if the playtest loop needs selector waits or event injection.

**Capture against the running preview server.** Reuses `game_run`'s process, but `CaptureSpec` carries no process linkage, and coupling capture to a live run makes the observe loop two-phase. Rejected: a self-contained ephemeral serve keeps `game_capture_frame` one-shot and parallel to the Godot probe.

## Consequences

- Web games join the registry as `engine: "web"` with zero new model-facing surface: the six existing tools reach them unchanged.
- The `web` engine needs no global install beyond node + (for captures) a Chromium-family browser; project tooling stays inside the project.
- First-paint capture and no input delivery are recorded as Known Limitations, not surprises; `browserExtraArgs` is the documented warm-up lever.
- The serve probe joins `assets/` alongside the Godot probes — same probe contract shape (`<PREFIX>_RESULT`-style stdout line), same files-whitelist treatment.
