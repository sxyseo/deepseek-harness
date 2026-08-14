/**
 * Vocabulary for the game runtime capability seam (`ctx.gameRuntimes`): named engine
 * registrations, execution-time engine resolution, build/run/observe/input requests and
 * results, live process handles, and the {@link GameError} taxonomy. One vocabulary serves
 * every engine provider (Godot, Unity, Unreal, ...) and every model-facing consumer.
 * @module @deepseek-ai/dsh-game-runtime/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** One registered engine's stable id — `'godot'`, `'unity'`, `'unreal'`, or a custom backend name. */
export type GameEngineId = string

/**
 * Registry-level run request. `engine` is optional: the registry resolves it at execution time
 * (an explicit id wins; otherwise exactly one registered runtime is required, so selection never
 * depends on registration order).
 */
export interface GameRunRequest {
  /** The engine to run with; omitted = auto-select when exactly one engine is registered. */
  readonly engine?: GameEngineId | undefined
  /** Path to the engine project directory (for Godot: the folder containing `project.godot`). */
  readonly project: string
  /** Extra CLI arguments appended after the engine's run defaults. */
  readonly args?: readonly string[] | undefined
  /** Working directory override; the provider's resolved spec defaults it to the project path. */
  readonly cwd?: string | undefined
  /** Explicit child environment entries merged over the provider's scrubbed parent base. */
  readonly env?: Readonly<Record<string, string>> | undefined
}

/** Fully resolved spawn description for one engine run, produced by {@link EngineRuntime.resolve}. */
export interface GameRunSpec {
  /** The engine that produced this spec. */
  readonly engine: GameEngineId
  /** Canonical project directory the process runs in/against. */
  readonly projectPath: string
  /** Complete argv — engine executable, its headless/run flags, and the caller's extras. */
  readonly argv: readonly string[]
  /** Working directory for the child. */
  readonly cwd: string
  /** Explicit environment entries for the child, merged over the provider's scrub. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Termination grace period in milliseconds for the managed process tree. */
  readonly graceMs: number
}

/** Registry-level build request; `engine` resolves with the same rules as {@link GameRunRequest}. */
export interface GameBuildRequest {
  /** The engine to build with; omitted = auto-select when exactly one engine is registered. */
  readonly engine?: GameEngineId | undefined
  /** Path to the engine project directory. */
  readonly project: string
  /** Engine-specific export preset or target name (for Godot: an `export_presets.cfg` preset). */
  readonly exportPreset?: string | undefined
  /** Expected build artifact path; the provider fills it into the result when omitted. */
  readonly outputPath?: string | undefined
  /** Extra CLI arguments appended after the engine's build defaults. */
  readonly args?: readonly string[] | undefined
  /** Working directory override; the provider's resolved spec defaults it to the project path. */
  readonly cwd?: string | undefined
  /** Explicit child environment entries merged over the provider's scrubbed parent base. */
  readonly env?: Readonly<Record<string, string>> | undefined
}

/** Fully resolved build description for one engine, produced by {@link EngineRuntime.resolveBuild}. */
export interface GameBuildSpec {
  /** The engine that produced this spec. */
  readonly engine: GameEngineId
  /** Canonical project directory the build runs in. */
  readonly projectPath: string
  /** Complete argv — engine executable and its import/export flags. */
  readonly argv: readonly string[]
  /** Working directory for the child. */
  readonly cwd: string
  /** Explicit environment entries for the child, merged over the provider's scrub. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Termination grace period in milliseconds for the managed process tree. */
  readonly graceMs: number
  /** The expected build artifact path, when the build declares one. */
  readonly outputPath?: string | undefined
}

/** Bounded engine log text. `truncated` marks bytes dropped from the head or tail. */
export interface GameLogText {
  /** The retained log text. */
  readonly text: string
  /** True when the complete stream exceeded the provider's retention bounds. */
  readonly truncated: boolean
}

/**
 * One build outcome. A non-zero exit code is a RESULT (`ok: false`), not a rejection — the
 * engine ran and reported its failure. Rejection is reserved for contract misuse and
 * spawn-level failures (missing executable, invalid request).
 */
export interface GameBuildResult {
  /** The engine that ran the build. */
  readonly engine: GameEngineId
  /** True when the build exited zero. */
  readonly ok: boolean
  /** Process exit code; `null` when the process died from a signal. */
  readonly exitCode: number | null
  /** The produced artifact path, when the build declared one. */
  readonly outputPath?: string | undefined
  /** Bounded engine log. */
  readonly log: GameLogText
}

/** Exit facts of one closed game process (the engine CLI's exit vocabulary). */
export interface GameProcessOutcome {
  /** Exit code; `null` when the process died from a signal. */
  readonly exitCode: number | null
  /** Terminating signal; `null` on normal exit. */
  readonly signal: NodeJS.Signals | null
}

/** Runtime-derived state facts for one tracked game process. */
export interface GameProcessInfo {
  /** The registry-owned process id (`game_run` returns this to the model). */
  readonly processId: string
  /** The engine that started the process. */
  readonly engine: GameEngineId
  /** Operating-system process id of the spawned tree root. */
  readonly pid: number
  /** `running` until the process tree exits; `exited` afterwards. */
  readonly state: 'running' | 'exited'
  /** Exit code once exited; `null` while running or when killed by a signal. */
  readonly exitCode: number | null
}

/**
 * A live started game process. Collected output stays readable after exit, so the final
 * crash log is recoverable through {@link readLog} until the registry drops the record.
 */
export interface GameProcess {
  /** The registry-owned process id. */
  readonly processId: string
  /** The engine that started the process. */
  readonly engine: GameEngineId
  /** Runtime-derived state facts (cheap; never performs I/O). */
  info(): GameProcessInfo
  /** Resolves at process-tree exit with exit facts; rejects only for spawn-level failures. */
  readonly outcome: Promise<GameProcessOutcome>
  /** Read the engine log captured since the process started (offset-based, non-consuming). */
  readLog(): GameLogText
  /** Begin the provider's termination escalation on the process tree (idempotent). */
  terminate(): void
  /**
   * Wait until the process tree has exited.
   * @param signal - optional bound for the wait.
   * @returns `true` when the tree exited, `false` when the signal aborted first.
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/** Registry-level log read request for one tracked process. */
export interface GameReadLogRequest {
  /** The process id returned by `game_run`. */
  readonly processId: string
  /** The engine that started it; omitted = auto-select when exactly one engine is registered. */
  readonly engine?: GameEngineId | undefined
}

/** Runtime-level frame-capture spec (M3 observation seam; providers own the mechanism). */
export interface CaptureSpec {
  /** Canonical project directory. */
  readonly projectPath: string
  /** Where the captured PNG is written. */
  readonly outputPath: string
  /** Viewport width override; omitted = the engine's default. */
  readonly width?: number | undefined
  /** Viewport height override; omitted = the engine's default. */
  readonly height?: number | undefined
}

/** One captured engine frame. */
export interface GameFrame {
  /** Path to the captured image file. */
  readonly imagePath: string
  /** Image width in pixels. */
  readonly width: number
  /** Image height in pixels. */
  readonly height: number
}

/** Runtime-level scene-query spec (M2 refactor seam; providers own the mechanism). */
export interface SceneQuerySpec {
  /** Canonical project directory. */
  readonly projectPath: string
  /** Scene resource path to query; omitted = the project's main scene. */
  readonly scenePath?: string | undefined
}

/** One node of a queried scene tree. */
export interface SceneNode {
  /** Full node path from the scene root (Godot-style, e.g. `/root/Main/Player`). */
  readonly path: string
  /** Engine node/class type (e.g. `Node2D`). */
  readonly type: string
  /** Node name. */
  readonly name: string
  /** Child nodes in scene order. */
  readonly children: readonly SceneNode[]
}

/** The queried scene's tree snapshot. */
export interface SceneInfo {
  /** The scene resource path that was queried. */
  readonly scenePath: string
  /** The scene root node. */
  readonly root: SceneNode
}

/** Runtime-level input spec (M4 playtest seam; providers own the mechanism). */
export interface InputSpec {
  /** The running process that receives the input. */
  readonly processId: string
  /** Provider-specific action name (e.g. `key_press`, `mouse_click`, `touch`). */
  readonly action: string
  /** Action parameters (key codes, coordinates, ...); provider-validated. */
  readonly params?: Readonly<Record<string, unknown>> | undefined
}

/** Outcome of one input delivery. */
export interface InputResult {
  /** True when the running game accepted the input. */
  readonly accepted: boolean
}

/** Machine-routable game-seam error codes. Providers may add provider-specific codes. */
export type GameErrorCode =
  | 'GAME_DUPLICATE_RUNTIME'
  | 'GAME_ENGINE_UNKNOWN'
  | 'GAME_ENGINE_AMBIGUOUS'
  | 'GAME_ENGINE_UNAVAILABLE'
  | 'GAME_INVALID_REQUEST'
  | 'GAME_EXECUTABLE_MISSING'
  | 'GAME_PROCESS_UNKNOWN'
  | 'GAME_CAPABILITY_UNAVAILABLE'

/**
 * Typed game-seam error with a machine-routable, open-string `code`. Shared codes cover
 * duplicate runtime registration, unknown/ambiguous/unavailable engine resolution, invalid
 * requests, missing engine executables, unknown process ids, and capabilities a provider has
 * not implemented yet. Consumers must tolerate provider-specific codes.
 */
export class GameError extends HarnessError {}
