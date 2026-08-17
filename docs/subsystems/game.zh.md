# 游戏运行时

[English](game.md) | 中文

多引擎游戏运行时 seam：带执行期引擎解析、存活进程跟踪与构建/运行/观察/输入执行表面的引擎后端命名注册表。[帧捕获 Agent Note](../../.agents/notes/implemented/architecture/2026-08-14-game-frame-capture.md) 拥有观察回路的决策，[web 后端 note](../../.agents/notes/implemented/architecture/2026-08-17-game-runtime-web.md) 拥有 Vite/浏览器门面的决策；[seam 包 README](../../packages/game/game-runtime/README.md) 拥有词汇与选择语义，[工具 consumer](../../packages/game/tool-game/README.md) 拥有模型可见契约，引擎后端（[Godot](../../packages/game/game-runtime-godot/README.md)、[web](../../packages/game/game-runtime-web/README.md)）拥有各自文档化的机制。

## 服务行为

[`GameRuntimeRegistry`](../../packages/game/game-runtime/src/index.ts) 逐调用解析引擎（显式 `engine` 优先；其次配置的 `defaultEngine`；否则必须恰好注册一个引擎，选择永不依赖注册顺序），跟踪每个已启动进程以支持有界日志读取与树级终止，并保留一段已退出进程窗口供最终崩溃日志读取。Provider 实现 `EngineRuntime` 并注册进注册表；consumer 只调用注册表面。

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
