# @deepseek-ai/dsh-game-runtime-godot

English | [中文](README.zh.md)

Godot engine backend for the DeepSeek Harness game runtime seam (`ctx.gameRuntimes`). The provider is a facade over the Godot CLI spawned through `ctx.subprocess` — it forks no Godot code; it drives the engine binary in headless mode for builds (import/export) and runs, and tracks each live process for bounded log reads and tree-scoped termination.

## Registration

The plugin registers `{ engine: 'godot', runtime: GodotRuntime }` into `ctx.gameRuntimes`; disposal unregisters it (and, through the registry, terminates any process this backend started).

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `godotExecutable` | `'godot'` | Absolute path or bare PATH name; resolved through `ctx.subprocess.resolveExecutable` at spawn time. |
| `argvPrefix` | `[]` | Arguments inserted immediately after the executable, BEFORE the engine flags — the wrapper shape (`flatpak run org.godotengine.Godot`, a Node-run shim in tests). |
| `graceMs` | `5000` | Termination grace for the spawned process tree. |
| `maxLogBytes` | `262144` | Per-stream in-memory log cap (tail-kept beyond it). |

Operational overrides feed these same fields from the composition, not a hidden priority chain: `examples/game-agent/cordis.yml` wires `DSH_GODOT_EXECUTABLE` / `DSH_GODOT_PREFIX` into the row's config expressions.

## Godot CLI contract

- **Run**: `godot --headless --path <project> [args...]` — starts the project's main scene; the process keeps running until terminated.
- **Build**: `godot --headless --path <project> --import`, followed by `--export-release <preset> <output>` when `exportPreset` is set (default output `<project>/dist/<preset>`).
- The project path must name an existing directory (`GAME_INVALID_REQUEST` otherwise). A non-zero engine exit is a build RESULT (`ok: false`), not a rejection.

## Model Experience

Indirectly, through the model-facing game tools (`dsh-tool-game`), which render this backend's builds, runs, and engine logs; the provider registers no prompt, schema, or result text of its own.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Frame capture, scene queries, and input delivery are not implemented** — the three observation/input methods throw `GAME_CAPABILITY_UNAVAILABLE`; they land with the M2–M4 milestones (scene queries and captures via a `--script` probe, input via a running bridge).
- **Headless only** — the backend never opens a GUI window or a real viewport; visual capture must use Godot's headless rendering paths.
- **No project.godot validation** — the backend checks the directory exists, not that it contains a valid Godot project; the engine's own error surfaces in the build/run log.
- **Export presets must pre-exist** — `exportPreset` must name a preset from the project's `export_presets.cfg`; the backend does not author presets.
