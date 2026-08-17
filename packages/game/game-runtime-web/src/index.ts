/**
 * Service Provider for the game runtime seam: the web engine backend
 * (`@deepseek-ai/dsh-game-runtime`). A facade over the project's own local
 * Vite installation and a Chromium-family browser, both spawned through
 * `ctx.subprocess` — the provider forks no engine code.
 *
 * The web backend treats a Vite-shaped npm project as the engine project:
 * builds and preview runs drive `node <project>/node_modules/vite/bin/vite.js`
 * (never a package-manager CLI, so no `.cmd` spawn pitfalls on Windows), frame
 * captures serve the build output through the shipped `assets/web-serve.mjs`
 * probe and screenshot it with the browser's `--headless --screenshot` mode,
 * and scene/asset queries are documented text heuristics over the project
 * files.
 *
 * Input delivery is declared by the seam but lands in a later milestone:
 * that method throws `GAME_CAPABILITY_UNAVAILABLE` rather than fake a result.
 * @module @deepseek-ai/dsh-game-runtime-web
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleepMs } from 'node:timers/promises'
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
} from '@deepseek-ai/dsh-game-runtime'
import { EngineRuntime, GameError, newGameProcessId } from '@deepseek-ai/dsh-game-runtime'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** The engine id this provider registers under (`ctx.gameRuntimes`). */
export const WEB_ENGINE_ID = 'web'

/** Stable Cordis plugin name. */
export const name = 'game-runtime-web'

/** Seams required before the provider can register. */
export const inject = ['gameRuntimes', 'subprocess']

/** Provider config; every field is optional and defaults below. */
export interface WebRuntimeConfig {
  /** Node executable used to drive Vite and the serve probe (default: this process's node). */
  readonly nodeExecutable?: string
  /** Browser executable for frame captures: an absolute path or a bare PATH name (default `chrome`). */
  readonly browserExecutable?: string
  /**
   * Arguments inserted immediately after the browser executable, BEFORE the
   * capture flags — the wrapper shape (a Node-run browser shim in tests).
   */
  readonly browserArgvPrefix?: string[]
  /** Extra browser arguments appended just before the capture URL (e.g. `--virtual-time-budget=3000`). */
  readonly browserExtraArgs?: string[]
  /** Build output directory inside the project, also the capture serving root (default `dist`). */
  readonly outputDir?: string
  /** Preview server port for `game_run` (default `4173`, Vite's preview default). */
  readonly previewPort?: number
  /** Default capture viewport width (default `1280`). */
  readonly captureWidth?: number
  /** Default capture viewport height (default `720`). */
  readonly captureHeight?: number
  /** Termination grace in milliseconds for spawned web process trees. */
  readonly graceMs?: number
  /** In-memory log cap per stream in bytes (tail-kept beyond it). */
  readonly maxLogBytes?: number
}

/** Schemastery configuration for the web provider. */
export const Config: z<WebRuntimeConfig> = z.object({
  nodeExecutable: z.string(),
  browserExecutable: z.string(),
  browserArgvPrefix: z.array(z.string()),
  browserExtraArgs: z.array(z.string()),
  outputDir: z.string(),
  previewPort: z.number(),
  captureWidth: z.number(),
  captureHeight: z.number(),
  graceMs: z.number(),
  maxLogBytes: z.number(),
})

/** Default termination grace for one web process tree. */
export const DEFAULT_WEB_GRACE_MS = 5000

/** Default per-stream log cap (256 KiB tail). */
export const DEFAULT_WEB_MAX_LOG_BYTES = 262144

/** Default preview port (Vite's own preview default). */
export const DEFAULT_WEB_PREVIEW_PORT = 4173

/** Default capture viewport (720p). */
export const DEFAULT_WEB_CAPTURE_WIDTH = 1280
export const DEFAULT_WEB_CAPTURE_HEIGHT = 720

/** Relative entry of the project-local Vite CLI inside `node_modules`. */
const VITE_ENTRY = join('node_modules', 'vite', 'bin', 'vite.js')

/** Live tracked web game process over one spawned subprocess tree. */
class WebProcess implements GameProcess {
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
 * The web engine backend. Registered as `{ engine: 'web', runtime }` into
 * `ctx.gameRuntimes` by this package's `apply`; the engine is the project's
 * own local Vite CLI driven through `ctx.subprocess` (builds and preview
 * runs) plus a browser CLI for frame captures — the provider never embeds
 * engine code.
 */
export class WebRuntime extends EngineRuntime {
  private readonly ctx: Context
  private readonly nodeExecutable: string
  private readonly browserExecutable: string
  private readonly browserArgvPrefix: readonly string[]
  private readonly browserExtraArgs: readonly string[]
  private readonly outputDir: string
  private readonly previewPort: number
  private readonly captureWidth: number
  private readonly captureHeight: number
  private readonly graceMs: number
  private readonly maxLogBytes: number

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(WEB_ENGINE_ID)
    this.ctx = ctx
    this.nodeExecutable = config.nodeExecutable ?? process.execPath
    this.browserExecutable = config.browserExecutable ?? 'chrome'
    this.browserArgvPrefix = config.browserArgvPrefix ?? []
    this.browserExtraArgs = config.browserExtraArgs ?? []
    this.outputDir = config.outputDir ?? 'dist'
    this.previewPort = config.previewPort ?? DEFAULT_WEB_PREVIEW_PORT
    this.captureWidth = config.captureWidth ?? DEFAULT_WEB_CAPTURE_WIDTH
    this.captureHeight = config.captureHeight ?? DEFAULT_WEB_CAPTURE_HEIGHT
    this.graceMs = config.graceMs ?? DEFAULT_WEB_GRACE_MS
    this.maxLogBytes = config.maxLogBytes ?? DEFAULT_WEB_MAX_LOG_BYTES
  }

  override resolve(request: GameRunRequest): GameRunSpec {
    const projectPath = resolveProject(request.project)
    return {
      engine: this.engine,
      projectPath,
      argv: [
        this.nodeExecutable, this.viteEntry(projectPath),
        'preview', '--port', String(this.previewPort), '--strictPort',
        ...(request.args ?? []),
      ],
      cwd: request.cwd ?? projectPath,
      ...request.env !== undefined ? { env: request.env } : {},
      graceMs: this.graceMs,
    }
  }

  override resolveBuild(request: GameBuildRequest): GameBuildSpec {
    const projectPath = resolveProject(request.project)
    if (request.exportPreset !== undefined) {
      throw new GameError(
        'web: the build script owns the artifact; wire extra targets as Vite modes via args (e.g. -- --mode production), not export presets',
        'GAME_INVALID_REQUEST',
      )
    }
    const outputPath = request.outputPath ?? join(projectPath, this.outputDir)
    return {
      engine: this.engine,
      projectPath,
      argv: [this.nodeExecutable, this.viteEntry(projectPath), 'build', ...(request.args ?? [])],
      cwd: request.cwd ?? projectPath,
      ...request.env !== undefined ? { env: request.env } : {},
      graceMs: this.graceMs,
      outputPath,
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
      throw new GameError('web: the capture output path must be a non-empty string', 'GAME_INVALID_REQUEST')
    }
    // Relative output paths resolve against the project directory, so the
    // reported imagePath is always absolute.
    const outputPath = isAbsolute(request.outputPath) ? request.outputPath : join(projectPath, request.outputPath)
    return {
      projectPath,
      outputPath,
      ...request.scenePath !== undefined ? { scenePath: request.scenePath } : {},
      ...request.width !== undefined ? { width: request.width } : {},
      ...request.height !== undefined ? { height: request.height } : {},
    }
  }

  override async build(spec: GameBuildSpec): Promise<GameBuildResult> {
    this.assertViteInstalled(spec.projectPath)
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec.argv, spec.cwd, spec.env))
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

  // oxlint-disable-next-line typescript/require-await -- the local spawn is synchronous; async satisfies the seam's Promise contract.
  override async start(spec: GameRunSpec): Promise<GameProcess> {
    this.assertViteInstalled(spec.projectPath)
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec.argv, spec.cwd, spec.env))
    return new WebProcess(this.engine, handle, this.maxLogBytes)
  }

  override async captureFrame(spec: CaptureSpec): Promise<GameFrame> {
    const serveRoot = join(spec.projectPath, this.outputDir)
    if (!existsSync(serveRoot)) {
      throw new GameError(
        `web frame capture found no build output at ${JSON.stringify(serveRoot)}; run game_build first`,
        'GAME_CAPTURE_FAILED',
      )
    }
    const serveScript = fileURLToPath(new URL('../assets/web-serve.mjs', import.meta.url))
    const server = this.ctx.subprocess.spawn(this.spawnSpec(
      [this.nodeExecutable, serveScript, serveRoot, '0'],
      spec.projectPath,
      spec.env,
    ))
    try {
      const url = await this.waitForServeUrl(server)
      const scenePath = spec.scenePath ?? 'index.html'
      const width = spec.width ?? this.captureWidth
      const height = spec.height ?? this.captureHeight
      // The browser cannot create missing output directories; the provider does.
      await mkdir(dirname(spec.outputPath), { recursive: true })
      const argv = [
        this.browserExecutable, ...this.browserArgvPrefix,
        '--headless', '--disable-gpu', '--hide-scrollbars',
        `--window-size=${String(width)}x${String(height)}`,
        `--screenshot=${spec.outputPath}`,
        ...this.browserExtraArgs,
        `${url}/${scenePath}`,
      ]
      const executable = await this.resolveExecutable(this.browserExecutable)
      const browser = this.ctx.subprocess.spawn(this.spawnSpec(argv, spec.projectPath, spec.env, executable))
      const outcome = await browser.done
      if (outcome.exitCode !== 0) {
        const detail = readCollectedLog(browser, this.maxLogBytes).text.trim()
        throw new GameError(`web frame capture failed (exit ${String(outcome.exitCode)}): ${detail || 'no browser output'}`, 'GAME_CAPTURE_FAILED')
      }
      return readPngFrame(spec.outputPath)
    } finally {
      server.terminate()
      await server.waitForExit()
    }
  }

  // oxlint-disable-next-line typescript/require-await -- filesystem reads are synchronous; async satisfies the seam's Promise contract.
  override async queryScene(spec: SceneQuerySpec): Promise<SceneInfo> {
    const scenePath = spec.scenePath ?? 'index.html'
    const absolute = join(spec.projectPath, scenePath)
    const info = statSync(absolute, { throwIfNoEntry: false })
    if (info === undefined || !info.isFile()) {
      throw new GameError(`web scene query failed: ${JSON.stringify(absolute)} is not an existing file`, 'GAME_QUERY_FAILED')
    }
    const root = parseHtmlScene(readFileSync(absolute, 'utf8'), scenePath)
    return { scenePath, root }
  }

  // oxlint-disable-next-line typescript/require-await -- filesystem reads are synchronous; async satisfies the seam's Promise contract.
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
      ...kind === 'script' ? { script: parseScriptHeader(content) } : {},
    }
  }

  // oxlint-disable-next-line typescript/require-await -- async stub shape: the M4 implementation awaits input delivery.
  override async sendInput(_spec: InputSpec): Promise<InputResult> {
    throw new GameError('the web backend has not implemented input delivery yet (M4 playtest seam)', 'GAME_CAPABILITY_UNAVAILABLE')
  }

  /** The project-local Vite CLI entry; the web engine's binary. */
  private viteEntry(projectPath: string): string {
    return join(projectPath, VITE_ENTRY)
  }

  /** Fail loud with the shared executable code when the project has no local Vite. */
  private assertViteInstalled(projectPath: string): void {
    if (!existsSync(this.viteEntry(projectPath))) {
      throw new GameError(
        `web: ${JSON.stringify(this.viteEntry(projectPath))} is missing; the project must install vite before it can build or run`,
        'GAME_EXECUTABLE_MISSING',
      )
    }
  }

  /** Resolve the browser executable in the subprocess seam's execution world. */
  private async resolveExecutable(program: string): Promise<string> {
    try {
      return await this.ctx.subprocess.resolveExecutable(program)
    } catch (error: unknown) {
      throw new GameError(`cannot resolve the browser executable ${JSON.stringify(program)}`, 'GAME_EXECUTABLE_MISSING', { cause: error })
    }
  }

  /**
   * Poll the serve probe's collected stdout for its one `WEB_SERVE_URL` line.
   * @returns the advertised origin (e.g. `http://127.0.0.1:<port>`).
   */
  private async waitForServeUrl(server: SubprocessHandle): Promise<string> {
    const exited = server.done.then((): boolean => true, (): boolean => true)
    for (let attempt = 0; attempt < 250; attempt++) {
      const text = server.collected.stdout?.readFrom(0).text ?? ''
      const line = text.split(/\r?\n/).map(entry => entry.trim()).find(entry => entry.startsWith('WEB_SERVE_URL '))
      if (line !== undefined) return line.slice('WEB_SERVE_URL '.length)
      if (await Promise.race([exited, sleepMs(WAIT_TICK_MS).then((): boolean => false)])) break
    }
    const detail = readCollectedLog(server, this.maxLogBytes).text.trim()
    throw new GameError(`web frame capture failed: the serve probe never advertised a URL: ${detail || 'no probe output'}`, 'GAME_CAPTURE_FAILED')
  }

  /** Build the fully-specified spawn request; collected output stays tail-bounded. */
  private spawnSpec(
    argv: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>> | undefined,
    executable?: string,
  ): SubprocessSpawnSpec {
    const program = executable ?? argv[0]
    if (program === undefined) {
      throw new GameError('web: a spawn spec carries an empty argv', 'GAME_INVALID_REQUEST')
    }
    return {
      argv: [program, ...argv.slice(1)],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.maxLogBytes },
        stderr: { maxBytes: this.maxLogBytes },
      },
      graceMs: this.graceMs,
      ...env !== undefined ? { env } : {},
    }
  }
}

/** Poll interval for the serve probe's URL advertisement. */
const WAIT_TICK_MS = 20

/** Validate and canonicalize one project path: it must name an existing directory. */
function resolveProject(project: string): string {
  if (project.trim() === '') {
    throw new GameError('web: the project path must be a non-empty string', 'GAME_INVALID_REQUEST')
  }
  const projectPath = resolve(project)
  const info = statSync(projectPath, { throwIfNoEntry: false })
  if (info === undefined || !info.isDirectory()) {
    throw new GameError(`web: the project path ${JSON.stringify(projectPath)} is not an existing directory`, 'GAME_INVALID_REQUEST')
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
 * Normalize one asset path to a project-relative form: absolute, escaping
 * (`..`), or backslash-separated paths are rejected — asset reads must stay
 * inside the project.
 */
function normalizeAssetPath(assetPath: string): string {
  if (assetPath.trim() === '') {
    throw new GameError('web: the asset path must be a non-empty string', 'GAME_INVALID_REQUEST')
  }
  if (isAbsolute(assetPath) || assetPath.includes('\\') || assetPath.split('/').includes('..')) {
    throw new GameError(
      `web: the asset path ${JSON.stringify(assetPath)} must be project-relative, never absolute or escaping`,
      'GAME_INVALID_REQUEST',
    )
  }
  return assetPath
}

const SCENE_EXTENSIONS = new Set(['html', 'htm'])
const SCRIPT_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'])
const TEXTURE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'gif', 'avif'])
const AUDIO_EXTENSIONS = new Set(['ogg', 'wav', 'mp3', 'flac', 'm4a', 'aac'])
const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2'])
const SHADER_EXTENSIONS = new Set(['glsl', 'vert', 'frag', 'wgsl'])
const CONFIG_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'cfg'])

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

/** One ES module class declaration: `export class X extends Y`. */
const TS_CLASS_LINE = /^export\s+(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/m

/**
 * Parse the declared header of a JavaScript/TypeScript module (text-level
 * heuristic): the first exported class and its base class.
 */
function parseScriptHeader(content: string): ScriptHeader {
  const match = TS_CLASS_LINE.exec(content)
  return {
    ...match?.[1] !== undefined ? { className: match[1] } : {},
    ...match?.[2] !== undefined ? { extends: match[2] } : {},
    tool: false,
  }
}

const HTML_TITLE = /<title>([^<]*)<\/title>/i
const HTML_SCRIPT_SRC = /<script[^>]*\bsrc="([^"]*)"/gi
const HTML_STYLESHEET_HREF = /<link[^>]*\brel="stylesheet"[^>]*\bhref="([^"]*)"|<link[^>]*\bhref="([^"]*)"[^>]*\brel="stylesheet"/gi
const HTML_ID_ELEMENT = /<(canvas|div|main|section|aside|header|footer|nav|video|audio)\b[^>]*\bid="([^"]*)"/gi

/**
 * Parse one HTML document into the shared {@link SceneNode} tree (text-level
 * heuristic over the DECLARED markup — it reports scripts, stylesheets, and
 * identified structural elements, not anything script code would create at
 * runtime).
 */
function parseHtmlScene(content: string, scenePath: string): SceneNode {
  const titleMatch = HTML_TITLE.exec(content)
  const stem = scenePath.split('/').at(-1) ?? scenePath
  const children: SceneNode[] = []
  const push = (type: string, name: string): void => {
    children.push({ path: `/${stem}/${name.replace(/^\/+/, '')}`, type, name, children: [] })
  }
  for (const match of content.matchAll(HTML_SCRIPT_SRC)) {
    if (match[1] !== undefined) push('script', match[1])
  }
  for (const match of content.matchAll(HTML_STYLESHEET_HREF)) {
    const href = match[1] ?? match[2]
    if (href !== undefined) push('stylesheet', href)
  }
  for (const match of content.matchAll(HTML_ID_ELEMENT)) {
    if (match[2] !== undefined) push(match[1] ?? 'element', match[2])
  }
  return {
    path: `/${stem}`,
    type: 'Document',
    name: titleMatch?.[1]?.trim() !== '' && titleMatch?.[1] !== undefined ? titleMatch[1].trim() : stem,
    children,
  }
}

/** PNG magic bytes; every capture output is validated before its size is read. */
const PNG_MAGIC = '89504e470d0a1a0a'

/**
 * Validate one captured PNG and read its pixel size from the IHDR chunk.
 * @returns the frame metadata.
 */
function readPngFrame(outputPath: string): GameFrame {
  let bytes: Buffer
  try {
    bytes = readFileSync(outputPath)
  } catch (error: unknown) {
    throw new GameError(`web frame capture failed: the browser wrote no file at ${JSON.stringify(outputPath)}`, 'GAME_CAPTURE_FAILED', { cause: error })
  }
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== PNG_MAGIC || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new GameError(`web frame capture failed: ${JSON.stringify(outputPath)} is not a PNG file`, 'GAME_CAPTURE_FAILED')
  }
  return { imagePath: outputPath, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * Register the web backend under `{ engine: 'web' }` in the game runtime
 * registry. Disposal of this fiber unregisters the runtime and (through the
 * registry) terminates any process this backend started.
 * @param ctx - registrant context carrying the game registry and subprocess seam.
 * @param config - validated provider config.
 */
export function apply(ctx: Context, config: WebRuntimeConfig): void {
  ctx.gameRuntimes.register(WEB_ENGINE_ID, new WebRuntime(ctx, config))
}
