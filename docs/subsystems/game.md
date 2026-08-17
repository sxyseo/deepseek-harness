# Game runtimes

English | [中文](game.zh.md)

The multi-engine game runtime seam: a named registry of engine backends with execution-time engine resolution, live process tracking, and the build/run/observe/input execution surface. The [frame-capture Agent Note](../../.agents/notes/implemented/architecture/2026-08-14-game-frame-capture.md) owns the observation-loop decisions and the [web backend note](../../.agents/notes/implemented/architecture/2026-08-17-game-runtime-web.md) owns the Vite/browser facade decisions; the [seam package README](../../packages/game/game-runtime/README.md) owns the vocabulary and selection semantics, the [tool consumer](../../packages/game/tool-game/README.md) owns the model-facing contract, and the engine backends ([Godot](../../packages/game/game-runtime-godot/README.md), [web](../../packages/game/game-runtime-web/README.md)) own their documented mechanisms.

## Service behavior

[`GameRuntimeRegistry`](../../packages/game/game-runtime/src/index.ts) resolves the engine per call (an explicit `engine` wins; otherwise the configured `defaultEngine`; otherwise exactly one registered engine must exist, so selection never depends on registration order), tracks every started process for bounded log reads and tree-scoped termination, and retains a bounded window of exited processes for final crash logs. Providers implement `EngineRuntime` and register into the registry; consumers only call the registry surface.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgameruntimes--gameruntimeregistry"></a>

### `ctx.gameRuntimes` — `GameRuntimeRegistry`

The game runtime registry. Registered as `ctx.gameRuntimes` (one instance per context).

Engine selection semantics (resolved at execution time, never order-dependent):

- An explicit call `engine` that is registered → that engine.
- An explicit call `engine` not registered → `GAME_ENGINE_UNKNOWN`.
- No call `engine`, a configured `defaultEngine` that is registered → that engine.
- No call `engine`, a configured `defaultEngine` not registered → `GAME_ENGINE_UNKNOWN`.
- No call or configured engine, exactly one registered engine → that engine.
- No call or configured engine, multiple registered engines → `GAME_ENGINE_AMBIGUOUS`.
- No registered engine → `GAME_ENGINE_UNAVAILABLE`.

```ts cordis-catalog
/**
 * Register one engine runtime under its engine name. Throws {@link GameError}
 * `GAME_DUPLICATE_RUNTIME` if the name is already registered. Returns a disposer; disposed
 * with the calling fiber.
 * @param engine - the engine id this runtime serves (e.g. `'godot'`); the registry key.
 * @param runtime - the runtime implementation.
 * @returns the disposer that unregisters the runtime.
 */
register(engine: GameEngineId, runtime: EngineRuntime): () => void

/**
 * The registered engine ids, in registration order.
 * @returns the ordered engine ids.
 */
names(): readonly string[]

/**
 * Resolve the engine runtime for one call with the selection rules above.
 * @param request - the optional per-call engine id.
 * @returns the selected runtime.
 */
resolve(request: { engine?: string | undefined }): EngineRuntime

/**
 * Run one build through the selected engine. A non-zero engine exit resolves with
 * `ok: false`; rejection is reserved for resolution and spawn-level failures.
 * @param request - the project, optional engine/export preset, and CLI extras.
 * @returns the build outcome.
 */
async build(request: GameBuildRequest): Promise<GameBuildResult>

/**
 * Start one game process through the selected engine and track it for `readLog`/disposal.
 * The returned handle stays readable (final log included) after the process exits.
 * @param request - the project, optional engine, and CLI extras.
 * @returns the live tracked process handle.
 */
async start(request: GameRunRequest): Promise<GameProcess>

/**
 * Query one scene tree snapshot through the selected engine.
 * @param request - the project, optional engine, and optional scene path.
 * @returns the scene tree snapshot.
 */
async queryScene(request: SceneQueryRequest): Promise<SceneInfo>

/**
 * Query one project asset through the selected engine. A missing asset resolves with
 * `exists: false`; rejection is reserved for resolution and invalid requests.
 * @param request - the project, optional engine, and asset path.
 * @returns the asset metadata.
 */
async queryAsset(request: AssetQueryRequest): Promise<AssetInfo>

/**
 * Capture one frame of the project through the selected engine, writing a PNG.
 * @param request - the project, output path, optional engine/scene, and viewport hints.
 * @returns the captured frame metadata.
 */
async captureFrame(request: CaptureRequest): Promise<GameFrame>

/**
 * The tracked process record for one id, or `undefined` when unknown.
 * @param processId - the process id returned by `game_run`.
 * @returns the tracked process record, when one exists.
 */
process(processId: string): GameProcess | undefined

/**
 * Read the engine log of one tracked process (offset-based and non-consuming; the final
 * crash log of an exited process stays readable).
 * @param request - the process id and its optional engine.
 * @returns the bounded log text.
 */
readLog(request: GameReadLogRequest): GameLogText

/**
 * Terminate one tracked process tree (idempotent) and keep its record for a final log read.
 * @param processId - the process id returned by `game_run`.
 */
stop(processId: string): void
```

Source: [`packages/game/game-runtime/src/index.ts:116`](../../packages/game/game-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
