/**
 * Service Provider for the game runtime seam: the Godot engine backend
 * (`@deepseek-ai/dsh-game-runtime`). A facade over the Godot CLI spawned
 * through `ctx.subprocess` — the provider forks no Godot code; it drives the
 * editor/runtime binary in headless mode for builds (import/export) and runs.
 *
 * Frame capture, scene queries, and input delivery are declared by the seam
 * but land in later milestones: those methods throw `GAME_CAPABILITY_UNAVAILABLE`
 * rather than fake a result.
 * @module @deepseek-ai/dsh-game-runtime-godot
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  CaptureSpec,
  GameBuildRequest,
  GameBuildResult,
  GameBuildSpec,
  GameFrame,
  GameLogText,
  GameProcess,
  GameProcessInfo,
  GameProcessOutcome,
  GameRunRequest,
  GameRunSpec,
  InputResult,
  InputSpec,
  SceneInfo,
  SceneQuerySpec,
} from '@deepseek-ai/dsh-game-runtime'
import { EngineRuntime, GameError, newGameProcessId } from '@deepseek-ai/dsh-game-runtime'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** The engine id this provider registers under (`ctx.gameRuntimes`). */
export const GODOT_ENGINE_ID = 'godot'

/** Stable Cordis plugin name. */
export const name = 'game-runtime-godot'

/** Seams required before the provider can register. */
export const inject = ['gameRuntimes', 'subprocess']

/** Provider config; every field is optional and defaults below. */
export interface GodotRuntimeConfig {
  /** Godot executable: an absolute path or a bare PATH name (default `godot`). */
  readonly godotExecutable?: string
  /**
   * Arguments inserted immediately after the executable, BEFORE the engine
   * flags — the wrapper/script shape (e.g. `flatpak run org.godotengine.Godot`,
   * or a Node-run engine shim in tests). A directly executable engine leaves
   * this empty.
   */
  readonly argvPrefix?: string[]
  /** Termination grace in milliseconds for spawned Godot process trees. */
  readonly graceMs?: number
  /** In-memory log cap per stream in bytes (tail-kept beyond it). */
  readonly maxLogBytes?: number
}

/** Schemastery configuration for the Godot provider. */
export const Config: z<GodotRuntimeConfig> = z.object({
  godotExecutable: z.string(),
  argvPrefix: z.array(z.string()),
  graceMs: z.number(),
  maxLogBytes: z.number(),
})

/** Default termination grace for one Godot process tree. */
export const DEFAULT_GODOT_GRACE_MS = 5000

/** Default per-stream log cap (256 KiB tail). */
export const DEFAULT_GODOT_MAX_LOG_BYTES = 262144

/** Live tracked Godot game process over one spawned subprocess tree. */
class GodotProcess implements GameProcess {
  readonly processId = newGameProcessId()
  readonly engine: string
  private readonly handle: SubprocessHandle
  private readonly maxLogBytes: number
  private readonly outcomePromise: Promise<GameProcessOutcome>
  private settled = false
  private exitCode: number | null = null

  constructor(engine: string, handle: SubprocessHandle, maxLogBytes: number) {
    this.engine = engine
    this.handle = handle
    this.maxLogBytes = maxLogBytes
    this.outcomePromise = handle.done.then((outcome) => {
      this.settled = true
      this.exitCode = outcome.exitCode
      return { exitCode: outcome.exitCode, signal: outcome.signal }
    })
  }

  get outcome(): Promise<GameProcessOutcome> {
    return this.outcomePromise
  }

  info(): GameProcessInfo {
    return {
      processId: this.processId,
      engine: this.engine,
      pid: this.handle.pid,
      state: this.settled ? 'exited' : 'running',
      exitCode: this.settled ? this.exitCode : null,
    }
  }

  readLog(): GameLogText {
    const stdout = this.handle.collected.stdout?.readFrom(0)
    const stderr = this.handle.collected.stderr?.readFrom(0)
    const parts: string[] = []
    if (stdout?.text !== undefined && stdout.text !== '') parts.push(stdout.text)
    if (stderr?.text !== undefined && stderr.text !== '') parts.push(stderr.text)
    const text = parts.join('\n')
    // The provider keeps a bounded tail window; an over-cap stream is lossy by construction.
    const truncated = (stdout?.lossy ?? false) || (stderr?.lossy ?? false) || text.length > this.maxLogBytes
    return { text: text.slice(-this.maxLogBytes), truncated }
  }

  terminate(): void {
    this.handle.terminate()
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> {
    return this.handle.waitForExit(signal)
  }
}

/**
 * The Godot engine backend. Registered as `{ engine: 'godot', runtime }` into
 * `ctx.gameRuntimes` by this package's `apply`; it spawns the Godot CLI through
 * `ctx.subprocess` and never embeds or forks engine code.
 *
 * Builds run `godot --headless --path <project> --import` and, when an export
 * preset is named, `--export-release <preset> <output>`; runs start
 * `godot --headless --path <project>` with the caller's extras appended.
 */
export class GodotRuntime extends EngineRuntime {
  private readonly ctx: Context
  private readonly executable: string
  private readonly argvPrefix: readonly string[]
  private readonly graceMs: number
  private readonly maxLogBytes: number

  constructor(ctx: Context, config: GodotRuntimeConfig = {}) {
    super(GODOT_ENGINE_ID)
    this.ctx = ctx
    this.executable = config.godotExecutable ?? 'godot'
    this.argvPrefix = config.argvPrefix ?? []
    this.graceMs = config.graceMs ?? DEFAULT_GODOT_GRACE_MS
    this.maxLogBytes = config.maxLogBytes ?? DEFAULT_GODOT_MAX_LOG_BYTES
  }

  override resolve(request: GameRunRequest): GameRunSpec {
    const projectPath = resolveProject(request.project)
    return {
      engine: this.engine,
      projectPath,
      argv: [this.executable, ...this.argvPrefix, '--headless', '--path', projectPath, ...(request.args ?? [])],
      cwd: request.cwd ?? projectPath,
      ...request.env !== undefined ? { env: request.env } : {},
      graceMs: this.graceMs,
    }
  }

  override resolveBuild(request: GameBuildRequest): GameBuildSpec {
    const projectPath = resolveProject(request.project)
    const argv: string[] = [this.executable, ...this.argvPrefix, '--headless', '--path', projectPath, '--import']
    let outputPath: string | undefined
    if (request.exportPreset !== undefined) {
      outputPath = request.outputPath ?? join(projectPath, 'dist', request.exportPreset)
      argv.push('--export-release', request.exportPreset, outputPath)
    }
    argv.push(...(request.args ?? []))
    return {
      engine: this.engine,
      projectPath,
      argv,
      cwd: request.cwd ?? projectPath,
      ...request.env !== undefined ? { env: request.env } : {},
      graceMs: this.graceMs,
      ...outputPath !== undefined ? { outputPath } : {},
    }
  }

  override async build(spec: GameBuildSpec): Promise<GameBuildResult> {
    const program = spec.argv[0]
    if (program === undefined) {
      throw new GameError('godot build spec carries an empty argv', 'GAME_INVALID_REQUEST')
    }
    const executable = await this.resolveExecutable(program, spec)
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, executable))
    const outcome = await handle.done
    const log = readCollectedLog(handle, this.maxLogBytes)
    return {
      engine: spec.engine,
      ok: outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      ...spec.outputPath !== undefined ? { outputPath: spec.outputPath } : {},
      log,
    }
  }

  override async start(spec: GameRunSpec): Promise<GameProcess> {
    const program = spec.argv[0]
    if (program === undefined) {
      throw new GameError('godot run spec carries an empty argv', 'GAME_INVALID_REQUEST')
    }
    const executable = await this.resolveExecutable(program, spec)
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, executable))
    return new GodotProcess(this.engine, handle, this.maxLogBytes)
  }

  override async captureFrame(_spec: CaptureSpec): Promise<GameFrame> {
    throw new GameError('the godot backend has not implemented frame capture yet (M3 observation seam)', 'GAME_CAPABILITY_UNAVAILABLE')
  }

  override async queryScene(_spec: SceneQuerySpec): Promise<SceneInfo> {
    throw new GameError('the godot backend has not implemented scene queries yet (M2 refactor seam)', 'GAME_CAPABILITY_UNAVAILABLE')
  }

  override async sendInput(_spec: InputSpec): Promise<InputResult> {
    throw new GameError('the godot backend has not implemented input delivery yet (M4 playtest seam)', 'GAME_CAPABILITY_UNAVAILABLE')
  }

  /** Resolve the engine executable in the subprocess seam's execution world. */
  private async resolveExecutable(program: string, spec: GameRunSpec | GameBuildSpec): Promise<string> {
    try {
      return await this.ctx.subprocess.resolveExecutable(program, spec.env)
    } catch (error: unknown) {
      throw new GameError(`cannot resolve the godot executable ${JSON.stringify(program)}`, 'GAME_EXECUTABLE_MISSING', { cause: error })
    }
  }

  /** Build the fully-specified spawn request; collected output stays tail-bounded. */
  private spawnSpec(spec: GameRunSpec | GameBuildSpec, executable: string): SubprocessSpawnSpec {
    const argv = [executable, ...spec.argv.slice(1)]
    return {
      argv,
      cwd: spec.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.maxLogBytes },
        stderr: { maxBytes: this.maxLogBytes },
      },
      graceMs: spec.graceMs,
      ...spec.env !== undefined ? { env: spec.env } : {},
    }
  }
}

/** Validate and canonicalize one project path: it must name an existing directory. */
function resolveProject(project: string): string {
  if (project.trim() === '') {
    throw new GameError('godot: the project path must be a non-empty string', 'GAME_INVALID_REQUEST')
  }
  const projectPath = resolve(project)
  const info = statSync(projectPath, { throwIfNoEntry: false })
  if (info === undefined || !info.isDirectory()) {
    throw new GameError(`godot: the project path ${JSON.stringify(projectPath)} is not an existing directory`, 'GAME_INVALID_REQUEST')
  }
  return projectPath
}

/** Read both collected streams from offset zero into one bounded log. */
function readCollectedLog(handle: SubprocessHandle, maxLogBytes: number): GameLogText {
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  const parts: string[] = []
  if (stdout?.text !== undefined && stdout.text !== '') parts.push(stdout.text)
  if (stderr?.text !== undefined && stderr.text !== '') parts.push(stderr.text)
  const text = parts.join('\n')
  return { text: text.slice(-maxLogBytes), truncated: (stdout?.lossy ?? false) || (stderr?.lossy ?? false) || text.length > maxLogBytes }
}

/**
 * Register the Godot backend under `{ engine: 'godot' }` in the game runtime
 * registry. Disposal of this fiber unregisters the runtime and (through the
 * registry) terminates any process this backend started.
 * @param ctx - registrant context carrying the game registry and subprocess seam.
 * @param config - validated provider config.
 */
export function apply(ctx: Context, config: GodotRuntimeConfig): void {
  ctx.gameRuntimes.register(GODOT_ENGINE_ID, new GodotRuntime(ctx, config))
}
