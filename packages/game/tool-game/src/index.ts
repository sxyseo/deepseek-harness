/**
 * Model-facing game tools over the game runtime capability seam
 * (`ctx.gameRuntimes`): `game_build`, `game_run`, and `game_read_log`. Each
 * tool carries an optional `engine` field resolved by the registry (an explicit
 * id wins; otherwise exactly one registered engine is required). The tools are
 * thin consumers — build/run execution, process tracking, and log reads live in
 * the seam, so every engine provider (Godot, Unity, Unreal, ...) is reachable
 * through the same three tools.
 * @module @deepseek-ai/dsh-tool-game
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: resolves ctx.gameRuntimes for this package's program.
import { GameError } from '@deepseek-ai/dsh-game-runtime'

export const name = 'tool-game'
export const inject = ['tools', 'gameRuntimes']

/** Stable tool names, exported for e2e assertions and catalogs. */
export const GAME_BUILD_TOOL = 'game_build'
export const GAME_RUN_TOOL = 'game_run'
export const GAME_READ_LOG_TOOL = 'game_read_log'

/**
 * Register the three game tools on `ctx.tools`. Disposing the owning fiber
 * unregisters them.
 * @param ctx - registrant context carrying the tool registry and the game runtime registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: GAME_BUILD_TOOL,
    description: 'Build a game engine project through the registered engine runtime (imports assets and optionally exports a preset). Returns the exit status and bounded engine log.',
    parameters: {
      engine: {
        type: 'string',
        description: 'Engine id (e.g. "godot"). Omit when exactly one engine is registered.',
      },
      project: {
        type: 'string',
        required: true,
        description: 'Path to the engine project directory (for Godot: the folder containing project.godot).',
      },
      exportPreset: {
        type: 'string',
        description: 'Engine-specific export preset/target name (e.g. a Godot export preset from export_presets.cfg).',
      },
      outputPath: {
        type: 'string',
        description: 'Build artifact output path. Defaults to <project>/dist/<exportPreset> when omitted.',
      },
      args: {
        type: 'array',
        description: 'Extra CLI arguments appended after the engine build defaults.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engine: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          outputPath: { type: 'string' },
          log: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `game_build(${value.engine}) succeeded${value.outputPath !== undefined ? `; artifact: ${value.outputPath}` : ''}${value.log.text === '' ? '.' : `:\n${value.log.text}`}`
          : `game_build(${value.engine}) failed with exit code ${String(value.exitCode)}:\n${value.log.text}`,
      }],
    },
    async execute(args, exec) {
      const result = await ctx.gameRuntimes.build({
        ...args.engine !== undefined ? { engine: args.engine } : {},
        project: args.project,
        ...args.exportPreset !== undefined ? { exportPreset: args.exportPreset } : {},
        ...args.outputPath !== undefined ? { outputPath: args.outputPath } : {},
        ...args.args !== undefined ? { args: args.args } : {},
      })
      exec.signal.throwIfAborted()
      return {
        engine: result.engine,
        ok: result.ok,
        exitCode: result.exitCode,
        ...result.outputPath !== undefined ? { outputPath: result.outputPath } : {},
        log: result.log,
      }
    },
    presentCall: args => ({
      card: 'terminal',
      title: `${args.engine ?? 'engine'} build ${args.project}`,
      cwd: args.project,
    }),
  }))

  ctx.tools.register(defineTool({
    name: GAME_RUN_TOOL,
    description: 'Start a game engine project as a tracked background process. Returns the processId used by game_read_log to read its engine log. The process keeps running until the session ends or the registry stops it.',
    parameters: {
      engine: {
        type: 'string',
        description: 'Engine id (e.g. "godot"). Omit when exactly one engine is registered.',
      },
      project: {
        type: 'string',
        required: true,
        description: 'Path to the engine project directory (for Godot: the folder containing project.godot).',
      },
      args: {
        type: 'array',
        description: 'Extra CLI arguments appended after the engine run defaults.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          processId: { type: 'string', required: true },
          engine: { type: 'string', required: true },
          pid: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `game_run(${value.engine}) started process ${value.processId} (pid ${String(value.pid)}). Read its log with game_read_log.`,
      }],
    },
    async execute(args, exec) {
      const process = await ctx.gameRuntimes.start({
        ...args.engine !== undefined ? { engine: args.engine } : {},
        project: args.project,
        ...args.args !== undefined ? { args: args.args } : {},
      })
      exec.signal.throwIfAborted()
      const info = process.info()
      return { processId: info.processId, engine: info.engine, pid: info.pid }
    },
    presentCall: args => ({
      card: 'terminal',
      title: `${args.engine ?? 'engine'} run ${args.project}`,
      cwd: args.project,
    }),
  }))

  ctx.tools.register(defineTool({
    name: GAME_READ_LOG_TOOL,
    description: 'Read the engine log of a running or recently exited game process started by game_run (the final crash log of an exited process stays readable).',
    parameters: {
      processId: {
        type: 'string',
        required: true,
        description: 'The processId returned by game_run.',
      },
      engine: {
        type: 'string',
        description: 'Engine id that started the process. Omit when exactly one engine is registered.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          processId: { type: 'string', required: true },
          engine: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['running', 'exited'] },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          log: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.log.text === ''
          ? `game_read_log: ${value.processId} (${value.engine}, ${value.state}) produced no log output yet.`
          : `game_read_log: ${value.processId} (${value.engine}, ${value.state}):\n${value.log.text}`,
      }],
    },
    async execute(args) {
      // readLog throws GAME_PROCESS_UNKNOWN for an unknown id, so a reached
      // process lookup below is always defined.
      const log = ctx.gameRuntimes.readLog({
        processId: args.processId,
        ...args.engine !== undefined ? { engine: args.engine } : {},
      })
      const process = ctx.gameRuntimes.process(args.processId)
      if (process === undefined) {
        throw new GameError(`unknown game process "${args.processId}"`, 'GAME_PROCESS_UNKNOWN')
      }
      const info = process.info()
      return {
        processId: info.processId,
        engine: info.engine,
        state: info.state,
        exitCode: info.exitCode,
        log,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Read game log ${args.processId}`,
      kind: 'read',
      rawInput: { processId: args.processId },
    }),
  }))
}
