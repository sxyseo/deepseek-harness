/**
 * Service Definition for the game runtime capability seam (`ctx.gameRuntimes`): a named
 * registry of engine runtimes (Godot, Unity, Unreal, ...) with execution-time engine resolution,
 * live process tracking, and the build/run/observe/input execution surface. Duplicate engine
 * names are rejected. At execution time, an explicit `engine` must be registered; without one,
 * exactly one registered engine is required, so selection never depends on registration order.
 *
 * Providers (see `@deepseek-ai/dsh-game-runtime-godot`) implement {@link EngineRuntime} and
 * register it here; consumers (`@deepseek-ai/dsh-tool-game`) only call the registry surface.
 * @module @deepseek-ai/dsh-game-runtime
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  GameBuildRequest,
  GameBuildResult,
  GameBuildSpec,
  GameEngineId,
  GameFrame,
  GameProcess,
  GameReadLogRequest,
  GameRunRequest,
  GameRunSpec,
  GameLogText,
  InputResult,
  InputSpec,
  CaptureRequest,
  CaptureSpec,
  AssetInfo,
  AssetQueryRequest,
  AssetQuerySpec,
  SceneInfo,
  SceneQueryRequest,
  SceneQuerySpec,
} from './types.ts'
import { GameError } from './types.ts'

export {
  GameError,
} from './types.ts'
export type {
  GameErrorCode,
  GameBuildRequest,
  GameBuildResult,
  GameBuildSpec,
  GameEngineId,
  GameFrame,
  GameLogText,
  GameProcess,
  GameProcessInfo,
  GameProcessOutcome,
  GameReadLogRequest,
  GameRunRequest,
  GameRunSpec,
  InputResult,
  InputSpec,
  CaptureRequest,
  CaptureSpec,
  AssetInfo,
  AssetQueryRequest,
  AssetQuerySpec,
  GameAssetKind,
  ScriptHeader,
  SceneInfo,
  SceneNode,
  SceneQueryRequest,
  SceneQuerySpec,
  TscnNodeEntry,
  TscnSkeleton,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gameRuntimes: GameRuntimeRegistry
  }
}

/** Selection inputs for execution-time engine resolution. */
interface EngineSelection {
  /** The explicitly configured default engine id, if any. */
  readonly configuredId?: string | undefined
  /** The explicit per-call engine id, if any (wins over the configured default). */
  readonly requestedId?: string | undefined
  /** Runtimes registered under their engine names. */
  readonly runtimes: ReadonlyMap<string, EngineRuntime>
}

/**
 * Config for the game runtime seam. `defaultEngine` pins which engine wins when a call omits
 * `engine` (still overridable per call); both are optional — a single registered engine
 * auto-selects. Operational overrides such as environment variables must feed these same
 * fields rather than introduce a hidden priority chain.
 */
export interface GameRuntimeRegistryConfig {
  /** Default engine id used when a call omits `engine`. Omitted = auto-select when exactly one registered. */
  readonly defaultEngine?: string
}

/** Cap on exited processes the registry retains for post-exit log reads (oldest evicted first). */
export const MAX_RETAINED_EXITED_PROCESSES = 32

/**
 * The game runtime registry. Registered as `ctx.gameRuntimes` (one instance per context).
 *
 * Engine selection semantics (resolved at execution time, never order-dependent):
 * - An explicit call `engine` that is registered → that engine.
 * - An explicit call `engine` not registered → `GAME_ENGINE_UNKNOWN`.
 * - No call `engine`, a configured `defaultEngine` that is registered → that engine.
 * - No call `engine`, a configured `defaultEngine` not registered → `GAME_ENGINE_UNKNOWN`.
 * - No call or configured engine, exactly one registered engine → that engine.
 * - No call or configured engine, multiple registered engines → `GAME_ENGINE_AMBIGUOUS`.
 * - No registered engine → `GAME_ENGINE_UNAVAILABLE`.
 */
export class GameRuntimeRegistry extends Service {
  /** Registry config: the optional default engine id. */
  static Config: z<GameRuntimeRegistryConfig> = z.object({
    defaultEngine: z.string(),
  })

  private readonly runtimes = new Map<string, EngineRuntime>()
  private readonly processes = new Map<string, GameProcess>()
  private readonly defaultEngine: string | undefined

  constructor(ctx: Context, config: GameRuntimeRegistryConfig = {}) {
    super(ctx, 'gameRuntimes')
    this.defaultEngine = config.defaultEngine
    // Whole-registry disposal terminates every still-running managed game tree.
    const processes = this.processes
    this.ctx.effect(function* () {
      yield () => {
        for (const process of processes.values()) process.terminate()
        processes.clear()
      }
    }, 'gameRuntimes.dispose()')
  }

  /**
   * Register one engine runtime under its engine name. Throws {@link GameError}
   * `GAME_DUPLICATE_RUNTIME` if the name is already registered. Returns a disposer; disposed
   * with the calling fiber.
   * @param engine - the engine id this runtime serves (e.g. `'godot'`); the registry key.
   * @param runtime - the runtime implementation.
   * @returns the disposer that unregisters the runtime.
   */
  register(engine: GameEngineId, runtime: EngineRuntime): () => void {
    if (this.runtimes.has(engine)) {
      throw new GameError(`a game runtime for engine "${engine}" is already registered`, 'GAME_DUPLICATE_RUNTIME')
    }
    const runtimes = this.runtimes
    const dispose = this.ctx.effect(function* () {
      runtimes.set(engine, runtime)
      yield () => {
        // Remove only this registration's contribution: after dispose + re-register,
        // a stale disposer firing again must not remove the successor.
        if (runtimes.get(engine) === runtime) runtimes.delete(engine)
      }
    }, 'gameRuntimes.register()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * The registered engine ids, in registration order.
   * @returns the ordered engine ids.
   */
  names(): readonly string[] {
    return [...this.runtimes.keys()]
  }

  /**
   * Resolve the engine runtime for one call with the selection rules above.
   * @param request - the optional per-call engine id.
   * @returns the selected runtime.
   */
  resolve(request: { engine?: string | undefined }): EngineRuntime {
    return resolveRuntime({
      requestedId: request.engine,
      ...this.defaultEngine !== undefined ? { configuredId: this.defaultEngine } : {},
      runtimes: this.runtimes,
    })
  }

  /**
   * Run one build through the selected engine. A non-zero engine exit resolves with
   * `ok: false`; rejection is reserved for resolution and spawn-level failures.
   * @param request - the project, optional engine/export preset, and CLI extras.
   * @returns the build outcome.
   */
  async build(request: GameBuildRequest): Promise<GameBuildResult> {
    const runtime = this.resolve({ engine: request.engine })
    return runtime.build(runtime.resolveBuild(request))
  }

  /**
   * Start one game process through the selected engine and track it for `readLog`/disposal.
   * The returned handle stays readable (final log included) after the process exits.
   * @param request - the project, optional engine, and CLI extras.
   * @returns the live tracked process handle.
   */
  async start(request: GameRunRequest): Promise<GameProcess> {
    const runtime = this.resolve({ engine: request.engine })
    const process = await runtime.start(runtime.resolve(request))
    this.track(process)
    return process
  }

  /**
   * Query one scene tree snapshot through the selected engine.
   * @param request - the project, optional engine, and optional scene path.
   * @returns the scene tree snapshot.
   */
  async queryScene(request: SceneQueryRequest): Promise<SceneInfo> {
    const runtime = this.resolve({ engine: request.engine })
    return runtime.queryScene(runtime.resolveSceneQuery(request))
  }

  /**
   * Query one project asset through the selected engine. A missing asset resolves with
   * `exists: false`; rejection is reserved for resolution and invalid requests.
   * @param request - the project, optional engine, and asset path.
   * @returns the asset metadata.
   */
  async queryAsset(request: AssetQueryRequest): Promise<AssetInfo> {
    const runtime = this.resolve({ engine: request.engine })
    return runtime.queryAsset(runtime.resolveAssetQuery(request))
  }

  /**
   * Capture one frame of the project through the selected engine, writing a PNG.
   * @param request - the project, output path, optional engine/scene, and viewport hints.
   * @returns the captured frame metadata.
   */
  async captureFrame(request: CaptureRequest): Promise<GameFrame> {
    const runtime = this.resolve({ engine: request.engine })
    return runtime.captureFrame(runtime.resolveCapture(request))
  }

  /**
   * The tracked process record for one id, or `undefined` when unknown.
   * @param processId - the process id returned by `game_run`.
   * @returns the tracked process record, when one exists.
   */
  process(processId: string): GameProcess | undefined {
    return this.processes.get(processId)
  }

  /**
   * Read the engine log of one tracked process (offset-based and non-consuming; the final
   * crash log of an exited process stays readable).
   * @param request - the process id and its optional engine.
   * @returns the bounded log text.
   */
  readLog(request: GameReadLogRequest): GameLogText {
    const process = this.findProcess(request.processId)
    if (request.engine !== undefined && process.engine !== request.engine) {
      throw new GameError(`game process "${request.processId}" belongs to engine "${process.engine}", not "${request.engine}"`, 'GAME_PROCESS_UNKNOWN')
    }
    return process.readLog()
  }

  /**
   * Terminate one tracked process tree (idempotent) and keep its record for a final log read.
   * @param processId - the process id returned by `game_run`.
   */
  stop(processId: string): void {
    this.findProcess(processId).terminate()
  }

  /** Track one started process, evicting the oldest exited record past the retention cap. */
  private track(process: GameProcess): void {
    if (this.processes.has(process.processId)) {
      throw new GameError(`game process "${process.processId}" is already tracked`, 'GAME_INVALID_REQUEST')
    }
    this.processes.set(process.processId, process)
    const exited = [...this.processes.values()].filter(entry => entry.info().state === 'exited')
    while (exited.length > MAX_RETAINED_EXITED_PROCESSES) {
      const oldest = exited.shift()
      if (oldest === undefined) break
      this.processes.delete(oldest.processId)
    }
  }

  /** Resolve a tracked record or throw the matching {@link GameError}. */
  private findProcess(processId: string): GameProcess {
    const process = this.processes.get(processId)
    if (process === undefined) {
      throw new GameError(`unknown game process "${processId}" (start one with game_run first)`, 'GAME_PROCESS_UNKNOWN')
    }
    return process
  }
}

/** Resolve the selected runtime or throw the matching {@link GameError}. */
function resolveRuntime(selection: EngineSelection): EngineRuntime {
  const { configuredId, requestedId, runtimes } = selection
  if (requestedId !== undefined) {
    const runtime = runtimes.get(requestedId)
    if (runtime === undefined) {
      throw new GameError(`game runtime for engine "${requestedId}" is not registered`, 'GAME_ENGINE_UNKNOWN')
    }
    return runtime
  }
  if (configuredId !== undefined) {
    const runtime = runtimes.get(configuredId)
    if (runtime === undefined) {
      throw new GameError(`configured default game engine "${configuredId}" is not registered`, 'GAME_ENGINE_UNKNOWN')
    }
    return runtime
  }
  const [single] = [...runtimes.values()]
  if (single === undefined) {
    throw new GameError('no game runtime is registered', 'GAME_ENGINE_UNAVAILABLE')
  }
  if (runtimes.size > 1) {
    const engines = [...runtimes.keys()].join(', ')
    throw new GameError(`multiple game runtimes are registered (${engines}); select one with the engine field`, 'GAME_ENGINE_AMBIGUOUS')
  }
  return single
}

/**
 * One engine backend. Implementations are NOT Cordis services themselves: a provider plugin
 * (see `@deepseek-ai/dsh-game-runtime-godot`) constructs one and registers it into
 * `ctx.gameRuntimes`, which owns its lifetime. Providers typically drive the engine's own CLI
 * through `ctx.subprocess`; the seam itself stays mechanism-free.
 *
 * `start` is asynchronous because providers must resolve the engine executable in their
 * execution world before spawning; `captureFrame`/`sendInput` are the M3–M4
 * observation/input surface, and a provider that has not implemented one must throw
 * {@link GameError} `GAME_CAPABILITY_UNAVAILABLE` rather than fake it.
 */
export abstract class EngineRuntime {
  /** The engine id this runtime serves. */
  readonly engine: GameEngineId

  constructor(engine: GameEngineId) {
    this.engine = engine
  }

  /** Resolve one run request into a fully-specified spawn description. */
  abstract resolve(request: GameRunRequest): GameRunSpec

  /** Resolve one build request into a fully-specified build description. */
  abstract resolveBuild(request: GameBuildRequest): GameBuildSpec

  /** Resolve one scene-query request into a fully-specified query description. */
  abstract resolveSceneQuery(request: SceneQueryRequest): SceneQuerySpec

  /** Resolve one asset-query request into a fully-specified query description. */
  abstract resolveAssetQuery(request: AssetQueryRequest): AssetQuerySpec

  /** Resolve one frame-capture request into a fully-specified capture description. */
  abstract resolveCapture(request: CaptureRequest): CaptureSpec

  /** Run one build; a non-zero engine exit resolves with `ok: false`. */
  abstract build(spec: GameBuildSpec): Promise<GameBuildResult>

  /** Start one game process from a fully-specified spec. */
  abstract start(spec: GameRunSpec): Promise<GameProcess>

  /** Capture one frame of the project (M3 observation seam). */
  abstract captureFrame(spec: CaptureSpec): Promise<GameFrame>

  /** Query the project's scene tree (M2 refactor seam). */
  abstract queryScene(spec: SceneQuerySpec): Promise<SceneInfo>

  /** Query one project asset's metadata (M2 refactor seam). */
  abstract queryAsset(spec: AssetQuerySpec): Promise<AssetInfo>

  /** Deliver one input action to a running game process (M4 playtest seam). */
  abstract sendInput(spec: InputSpec): Promise<InputResult>
}

export default GameRuntimeRegistry

/** Random process id helper shared with providers so ids are registry-safe. */
export function newGameProcessId(): string {
  return `game-${randomUUID()}`
}
