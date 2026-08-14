# @deepseek-ai/dsh-game-runtime

English | [中文](README.zh.md)

Multi-engine game runtime capability seam (`ctx.gameRuntimes`) for the DeepSeek Harness: a named registry of engine backends (Godot, Unity, Unreal, ...) with order-independent engine resolution, live process tracking, and the build/run/observe/input vocabulary every provider and consumer shares. Duplicate engine names are rejected. At execution time, an explicit `engine` must be registered; without one, exactly one registered engine is required, so selection never depends on registration order.

## Service

`GameRuntimeRegistry` registers as `ctx.gameRuntimes` (one instance per context). Providers implement `EngineRuntime` and register it by engine name; consumers call only the registry surface.

### Engine resolution

- An explicit call `engine` that is registered → that engine.
- An explicit call `engine` not registered → `GAME_ENGINE_UNKNOWN`.
- No call `engine`, a configured `defaultEngine` that is registered → that engine.
- No call `engine`, a configured `defaultEngine` not registered → `GAME_ENGINE_UNKNOWN`.
- No call or configured engine, exactly one registered engine → that engine.
- No call or configured engine, multiple registered engines → `GAME_ENGINE_AMBIGUOUS`.
- No registered engine → `GAME_ENGINE_UNAVAILABLE`.

### Registry API

| Member | Contract |
| --- | --- |
| `register(engine, runtime)` | Register one `EngineRuntime` under its engine id. Duplicate ids throw `GAME_DUPLICATE_RUNTIME`. Returns a disposer (stale-disposer guarded); disposed with the calling fiber. |
| `names()` | The registered engine ids, in registration order. |
| `resolve({ engine? })` | Resolve the runtime with the selection rules above. |
| `build(request)` | Run one build through the selected engine; a non-zero engine exit resolves with `ok: false`. |
| `start(request)` | Start one game process through the selected engine and track it for `readLog`/disposal. |
| `process(processId)` | The tracked process record, or `undefined`. |
| `readLog({ processId, engine? })` | Read the tracked process's engine log; the final crash log of an exited process stays readable. |
| `stop(processId)` | Terminate one tracked process tree (idempotent); its record is kept for a final log read. |
| `queryScene({ project, scenePath?, engine? })` | Query one scene tree snapshot through the selected engine. |
| `queryAsset({ project, assetPath, engine? })` | Query one project asset's metadata; a missing asset resolves with `exists: false`. |

### Lifecycle

Registry disposal terminates every still-running tracked game tree. Registrations dispose with their contributing fiber (HMR safety). Exited process records are retained for post-exit log reads up to `MAX_RETAINED_EXITED_PROCESSES` (32); the oldest exited record is evicted beyond the cap.

## EngineRuntime

The abstract backend contract a provider implements; it is NOT a Cordis service itself — the registry owns its lifetime. `start` is asynchronous because providers must resolve the engine executable before spawning. `captureFrame` / `sendInput` are the M3–M4 observation/input surface; a provider that has not implemented one must throw `GameError` `GAME_CAPABILITY_UNAVAILABLE` rather than fake a result.

```ts
export abstract class EngineRuntime {
  abstract resolve(request: GameRunRequest): GameRunSpec
  abstract resolveBuild(request: GameBuildRequest): GameBuildSpec
  abstract resolveSceneQuery(request: SceneQueryRequest): SceneQuerySpec
  abstract resolveAssetQuery(request: AssetQueryRequest): AssetQuerySpec
  abstract build(spec: GameBuildSpec): Promise<GameBuildResult>
  abstract start(spec: GameRunSpec): Promise<GameProcess>
  abstract captureFrame(spec: CaptureSpec): Promise<GameFrame>
  abstract queryScene(spec: SceneQuerySpec): Promise<SceneInfo>
  abstract queryAsset(spec: AssetQuerySpec): Promise<AssetInfo>
  abstract sendInput(spec: InputSpec): Promise<InputResult>
}
```

## Errors

`GameError` extends `HarnessError` with a machine-routable code. Shared codes: `GAME_DUPLICATE_RUNTIME`, `GAME_ENGINE_UNKNOWN`, `GAME_ENGINE_AMBIGUOUS`, `GAME_ENGINE_UNAVAILABLE`, `GAME_INVALID_REQUEST`, `GAME_EXECUTABLE_MISSING`, `GAME_PROCESS_UNKNOWN`, `GAME_CAPABILITY_UNAVAILABLE`, `GAME_QUERY_FAILED`. Providers may add provider-specific codes; consumers must tolerate them.

## Model Experience

Indirectly, through the model-facing game tools (`dsh-tool-game`), which own all model-facing rendering of builds, runs, engine logs, and scene/asset queries; the registry itself registers no prompt, schema, or result text.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Frame capture and input delivery are declared but unimplemented** — `captureFrame` / `sendInput` exist on the seam so providers can grow into them; no Godot implementation or model-facing tool ships yet (M3–M4 milestones). Tools that do not exist yet: `game_capture_frame`, `game_send_input`.
- **No model-facing stop tool** — a started process runs until the session/registry disposes or the backend terminates it; `registry.stop()` is host API only. A `game_stop` tool is deferred to the playtest milestone.
- **Asset queries are provider-defined** — the seam normalizes kinds and structures (`tscn` skeleton, `script` header) but the extraction mechanism is each provider's documented choice; providers may differ in what they can report for exotic assets.
- **Engine availability is the deployment's job** — the seam resolves executables through `ctx.subprocess`; a deployment without an installed engine binary fails each build/run/query with `GAME_EXECUTABLE_MISSING`.
