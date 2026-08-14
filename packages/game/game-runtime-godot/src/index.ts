/**
 * Service Provider for the game runtime seam: the Godot engine backend
 * (`@deepseek-ai/dsh-game-runtime`). A facade over the Godot CLI spawned
 * through `ctx.subprocess` — the provider forks no Godot code; it drives the
 * editor/runtime binary in headless mode for builds (import/export), runs, and
 * scene queries (a `--script` probe), and classifies/parses project assets
 * with documented text heuristics.
 *
 * Frame capture and input delivery are declared by the seam but land in later
 * milestones: those methods throw `GAME_CAPABILITY_UNAVAILABLE` rather than
 * fake a result.
 * @module @deepseek-ai/dsh-game-runtime-godot
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AssetInfo,
  AssetQueryRequest,
  AssetQuerySpec,
  CaptureRequest,
  CaptureSpec,
  GameAssetKind,
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
  SceneNode,
  SceneQueryRequest,
  SceneQuerySpec,
  ScriptHeader,
  TscnNodeEntry,
  TscnSkeleton,
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

  override resolveSceneQuery(request: SceneQueryRequest): SceneQuerySpec {
    const projectPath = resolveProject(request.project)
    return {
      projectPath,
      ...request.scenePath !== undefined ? { scenePath: request.scenePath } : {},
    }
  }

  override resolveAssetQuery(request: AssetQueryRequest): AssetQuerySpec {
    const projectPath = resolveProject(request.project)
    return { projectPath, assetPath: normalizeAssetPath(request.assetPath) }
  }

  override resolveCapture(request: CaptureRequest): CaptureSpec {
    const projectPath = resolveProject(request.project)
    if (request.outputPath.trim() === '') {
      throw new GameError('godot: the capture output path must be a non-empty string', 'GAME_INVALID_REQUEST')
    }
    return {
      projectPath,
      outputPath: request.outputPath,
      ...request.scenePath !== undefined ? { scenePath: request.scenePath } : {},
      ...request.width !== undefined ? { width: request.width } : {},
      ...request.height !== undefined ? { height: request.height } : {},
    }
  }

  override async build(spec: GameBuildSpec): Promise<GameBuildResult> {
    const program = spec.argv[0]
    if (program === undefined) {
      throw new GameError('godot build spec carries an empty argv', 'GAME_INVALID_REQUEST')
    }
    const executable = await this.resolveExecutable(program, spec.env)
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
    const executable = await this.resolveExecutable(program, spec.env)
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, executable))
    return new GodotProcess(this.engine, handle, this.maxLogBytes)
  }

  override async captureFrame(spec: CaptureSpec): Promise<GameFrame> {
    const probePath = fileURLToPath(new URL('../assets/capture-frame.gd', import.meta.url))
    const program = this.executable
    const argv = [
      program, ...this.argvPrefix, '--headless', '--path', spec.projectPath,
      '--script', probePath, '--', spec.outputPath,
      ...(spec.scenePath !== undefined ? [spec.scenePath] : []),
      ...(spec.width !== undefined ? [String(spec.width)] : []),
      ...(spec.height !== undefined ? [String(spec.height)] : []),
    ]
    const executable = await this.resolveExecutable(program)
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...argv.slice(1)],
      cwd: spec.projectPath,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.maxLogBytes },
        stderr: { maxBytes: this.maxLogBytes },
      },
      graceMs: this.graceMs,
      ...spec.env !== undefined ? { env: spec.env } : {},
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    const resultLine = stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('CAPTURE_RESULT '))
    if (resultLine === undefined) {
      const detail = stderr.trim() || stdout.trim() || 'no probe output'
      throw new GameError(`godot frame capture failed (exit ${String(outcome.exitCode)}): ${detail}`, 'GAME_CAPTURE_FAILED')
    }
    try {
      const payload = JSON.parse(resultLine.slice('CAPTURE_RESULT '.length)) as { imagePath?: unknown; width?: unknown; height?: unknown }
      if (typeof payload.imagePath !== 'string' || typeof payload.width !== 'number' || typeof payload.height !== 'number') {
        throw new GameError('godot frame capture returned a malformed payload', 'GAME_CAPTURE_FAILED')
      }
      return { imagePath: payload.imagePath, width: payload.width, height: payload.height }
    } catch (error: unknown) {
      if (error instanceof GameError) throw error
      throw new GameError('godot frame capture returned an unparsable payload', 'GAME_CAPTURE_FAILED', { cause: error })
    }
  }

  override async queryScene(spec: SceneQuerySpec): Promise<SceneInfo> {
    const probePath = fileURLToPath(new URL('../assets/scene-query.gd', import.meta.url))
    const program = this.executable
    const argv = [
      program, ...this.argvPrefix, '--headless', '--path', spec.projectPath,
      '--script', probePath, '--', ...(spec.scenePath !== undefined ? [spec.scenePath] : []),
    ]
    const executable = await this.resolveExecutable(program)
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...argv.slice(1)],
      cwd: spec.projectPath,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.maxLogBytes },
        stderr: { maxBytes: this.maxLogBytes },
      },
      graceMs: this.graceMs,
      ...spec.env !== undefined ? { env: spec.env } : {},
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    const resultLine = stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('SCENE_QUERY_RESULT '))
    if (resultLine === undefined) {
      const detail = stderr.trim() || stdout.trim() || 'no probe output'
      throw new GameError(`godot scene query failed (exit ${String(outcome.exitCode)}): ${detail}`, 'GAME_QUERY_FAILED')
    }
    try {
      const payload = JSON.parse(resultLine.slice('SCENE_QUERY_RESULT '.length)) as { scenePath?: unknown; root?: unknown }
      const root = parseSceneNode(payload.root)
      if (typeof payload.scenePath !== 'string' || root === undefined) {
        throw new GameError('godot scene query returned a malformed payload', 'GAME_QUERY_FAILED')
      }
      return { scenePath: payload.scenePath, root }
    } catch (error: unknown) {
      if (error instanceof GameError) throw error
      throw new GameError('godot scene query returned an unparsable payload', 'GAME_QUERY_FAILED', { cause: error })
    }
  }

  override async queryAsset(spec: AssetQuerySpec): Promise<AssetInfo> {
    const absolute = join(spec.projectPath, spec.assetPath)
    const info = statSync(absolute, { throwIfNoEntry: false })
    const kind = classifyAssetKind(spec.assetPath)
    if (info === undefined || !info.isFile()) {
      return { assetPath: spec.assetPath, exists: false, kind }
    }
    const content = readFileSync(absolute, 'utf8')
    return {
      assetPath: spec.assetPath,
      exists: true,
      kind,
      bytes: info.size,
      ...kind === 'scene' ? { tscn: parseTscnSkeleton(content) } : {},
      ...kind === 'script' ? { script: parseScriptHeader(content) } : {},
    }
  }

  override async sendInput(_spec: InputSpec): Promise<InputResult> {
    throw new GameError('the godot backend has not implemented input delivery yet (M4 playtest seam)', 'GAME_CAPABILITY_UNAVAILABLE')
  }

  /** Resolve the engine executable in the subprocess seam's execution world. */
  private async resolveExecutable(program: string, env?: Readonly<Record<string, string>>): Promise<string> {
    try {
      return await this.ctx.subprocess.resolveExecutable(program, env)
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
 * Normalize one asset path to a project-relative form: an optional `res://`
 * prefix is stripped, and absolute, escaping (`..`), or backslash-separated
 * paths are rejected — asset reads must stay inside the project.
 */
function normalizeAssetPath(assetPath: string): string {
  if (assetPath.trim() === '') {
    throw new GameError('godot: the asset path must be a non-empty string', 'GAME_INVALID_REQUEST')
  }
  const normalized = assetPath.replace(/^res:\/\//, '')
  if (isAbsolute(normalized) || normalized.includes('\\') || normalized.split('/').includes('..')) {
    throw new GameError(
      `godot: the asset path ${JSON.stringify(assetPath)} must be project-relative (res:// or relative), never absolute or escaping`,
      'GAME_INVALID_REQUEST',
    )
  }
  return normalized
}

const SCENE_EXTENSIONS = new Set(['tscn', 'scn'])
const SCRIPT_EXTENSIONS = new Set(['gd'])
const TEXTURE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'ktx', 'dds', 'exr', 'hdr', 'tga'])
const AUDIO_EXTENSIONS = new Set(['ogg', 'wav', 'mp3', 'flac'])
const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2'])
const SHADER_EXTENSIONS = new Set(['gdshader'])
const CONFIG_EXTENSIONS = new Set(['godot', 'cfg'])

/** Classify one asset path by extension into the shared kind vocabulary. */
function classifyAssetKind(assetPath: string): GameAssetKind {
  const dot = assetPath.lastIndexOf('.')
  const extension = dot === -1 ? '' : assetPath.slice(dot + 1).toLowerCase()
  if (SCENE_EXTENSIONS.has(extension)) return 'scene'
  if (SCRIPT_EXTENSIONS.has(extension)) return 'script'
  if (TEXTURE_EXTENSIONS.has(extension)) return 'texture'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (FONT_EXTENSIONS.has(extension)) return 'font'
  if (SHADER_EXTENSIONS.has(extension)) return 'shader'
  if (CONFIG_EXTENSIONS.has(extension)) return 'config'
  return 'other'
}

/** Godot 4 `.tscn` node declaration: `[node name="X" type="Y" parent="Z"]` (root parent is `"."`). */
const TSCN_NODE_LINE = /^\[node\s+name="([^"]*)"\s+type="([^"]*)"(?:\s+parent="([^"]*)")?/

/**
 * Parse the declared node skeleton of a `.tscn` file (text-level heuristic over
 * Godot's node declarations — it reports what is DECLARED, not what the engine
 * would instantiate; inherited scenes are not expanded).
 * @returns the skeleton, or `undefined` when no root node is declared.
 */
function parseTscnSkeleton(content: string): TscnSkeleton | undefined {
  const nodes: TscnNodeEntry[] = []
  let root: string | undefined
  for (const line of content.split(/\r?\n/)) {
    const match = TSCN_NODE_LINE.exec(line)
    if (match === null) continue
    const name = match[1] ?? ''
    const type = match[2] ?? ''
    const parent = match[3] ?? '.'
    nodes.push({ name, type, parent })
    if (parent === '.') root = name
  }
  if (root === undefined) return undefined
  return { root, nodes }
}

/**
 * Parse the declared header of a GDScript file (text-level heuristic):
 * `extends`, `class_name`, and the `@tool` annotation.
 */
function parseScriptHeader(content: string): ScriptHeader {
  const extendsMatch = /^extends\s+(\S+)/m.exec(content)
  const classMatch = /^class_name\s+(\S+)/m.exec(content)
  const tool = /^@tool\b/m.test(content)
  return {
    ...extendsMatch?.[1] !== undefined ? { extends: extendsMatch[1] } : {},
    ...classMatch?.[1] !== undefined ? { className: classMatch[1] } : {},
    tool,
  }
}

/** Validate one probe-emitted node subtree into the shared {@link SceneNode} shape. */
function parseSceneNode(value: unknown): SceneNode | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string' || typeof raw.type !== 'string' || typeof raw.name !== 'string' || !Array.isArray(raw.children)) {
    return undefined
  }
  const children: SceneNode[] = []
  for (const child of raw.children) {
    const parsed = parseSceneNode(child)
    if (parsed === undefined) return undefined
    children.push(parsed)
  }
  return { path: raw.path, type: raw.type, name: raw.name, children }
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
