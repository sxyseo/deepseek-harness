# @deepseek-ai/dsh-game-runtime-web

English | [中文](README.zh.md)

Web engine backend for the DeepSeek Harness game runtime seam (`ctx.gameRuntimes`). The provider is a facade over the project's own local Vite installation and a Chromium-family browser, both spawned through `ctx.subprocess` — it forks no engine code. Vite-shaped npm projects (Vite/PixiJS, Phaser, plain canvas, ...) build and preview through `node <project>/node_modules/vite/bin/vite.js`, and frame captures screenshot the served build output with the browser's headless `--screenshot` mode.

## Registration

The plugin registers `{ engine: 'web', runtime: WebRuntime }` into `ctx.gameRuntimes`; disposal unregisters it (and, through the registry, terminates any process this backend started). Compose it beside (or instead of) the Godot backend; every model-facing game tool then reaches the web engine by passing `engine: "web"` (or the deployment pins `defaultEngine: web`).

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `nodeExecutable` | this process's node | Drives Vite and the serve probe; an absolute path. |
| `browserExecutable` | `'chrome'` | Browser for frame captures: absolute path or bare PATH name; resolved through `ctx.subprocess.resolveExecutable` at spawn time. |
| `browserArgvPrefix` | `[]` | Arguments inserted immediately after the browser executable, BEFORE the capture flags (a Node-run browser shim in tests). |
| `browserExtraArgs` | `[]` | Extra browser arguments appended just before the capture URL (e.g. `--virtual-time-budget=3000` to let the game render past first paint). |
| `outputDir` | `'dist'` | Build artifact directory inside the project; also the capture serving root. |
| `previewPort` | `4173` | Port for `game_run`'s preview server (`--port`, `--strictPort`). |
| `captureWidth` / `captureHeight` | `1280` / `720` | Default capture viewport; per-call `width`/`height` win. |
| `graceMs` | `5000` | Termination grace for the spawned process tree. |
| `maxLogBytes` | `262144` | Per-stream in-memory log cap (tail-kept beyond it). |

Operational overrides feed these same fields from the composition, not a hidden priority chain.

## Web project contract

- **Engine binary**: `node <project>/node_modules/vite/bin/vite.js` — the project's own local Vite. The provider never spawns a package-manager CLI (no `.cmd` pitfalls on Windows); a project without a local Vite fails every build/run with `GAME_EXECUTABLE_MISSING` (install first).
- **Run**: `vite preview --port <port> --strictPort [args...]` — serves the built output; the process keeps running until terminated.
- **Build**: `vite build [args...]` (default artifact `<project>/<outputDir>`). `exportPreset` is rejected (`GAME_INVALID_REQUEST`): the build script owns the artifact; wire extra targets as Vite modes via args.
- **Scene query**: filesystem-backed, no engine spawn — the HTML document (default `index.html`) is parsed as text into a `Document` root with `script` (src), `stylesheet` (href), and identified structural elements (`canvas`/`div`/... with `id`) as children. This is a documented text heuristic over the DECLARED markup, not runtime DOM.
- **Asset query**: filesystem-backed, no engine spawn — existence/size, an extension-derived `kind` (`html`→`scene`, `ts/js/...`→`script`, images→`texture`, `glsl/vert/frag/wgsl`→`shader`, ...), and an `export class X extends Y` header parsed from module text.
- **Frame capture**: the shipped `assets/web-serve.mjs` probe serves `<outputDir>` on an ephemeral loopback port and prints one `WEB_SERVE_URL <origin>` line; the browser then runs `--headless --disable-gpu --hide-scrollbars --window-size=WxH --screenshot=<path> <origin>/<scenePath>`. The provider validates the PNG and reads its size from the IHDR chunk; the output directory is created when missing. Failures surface as `GAME_CAPTURE_FAILED`.
- The project path must name an existing directory (`GAME_INVALID_REQUEST` otherwise). A non-zero engine exit is a build RESULT (`ok: false`), not a rejection.

## Model Experience

Indirectly, through the model-facing game tools (`dsh-tool-game`), which render this backend's builds, runs, engine logs, scene/asset queries, and frame captures; the provider registers no prompt, schema, or result text of its own.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Capture needs a Chromium-family browser** — `--headless --screenshot` is the capture mechanism; without an installed (or configured) browser, captures fail with `GAME_EXECUTABLE_MISSING`.
- **Captures are first-paint** — the screenshot is taken without a warm-up budget by default; games that render asynchronously should set `browserExtraArgs: ['--virtual-time-budget=3000']` or similar.
- **Input delivery is not implemented** — `sendInput` throws `GAME_CAPABILITY_UNAVAILABLE`; it lands with the M4 milestone.
- **Projects must be Vite-shaped** — the engine is the project's local `node_modules/vite/bin/vite.js`; non-Vite web projects (raw static sites, webpack) cannot build or run, though asset/scene queries still work.
- **No export presets** — `exportPreset` is rejected; the build script and Vite modes own the artifact.
- **Scene queries are text heuristics** — the parser reads the HTML as text; markup the page would create at runtime is invisible, and exotic attribute orders may parse partially.
- **The preview port is config-fixed** — `game_run` uses `previewPort` with `--strictPort`; a busy port fails the run loudly instead of migrating.
