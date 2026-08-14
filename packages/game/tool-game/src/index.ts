/**
 * Model-facing game tools over the game runtime capability seam
 * (`ctx.gameRuntimes`): `game_build`, `game_run`, `game_read_log`,
 * `game_query_scene`, and `game_query_asset`. Each tool carries an optional
 * `engine` field resolved by the registry (an explicit id wins; otherwise
 * exactly one registered engine is required). The tools are thin consumers —
 * execution, process tracking, and queries live in the seam, so every engine
 * provider (Godot, Unity, Unreal, ...) is reachable through the same tools.
 * The query tools feed the refactor loop: inspect the scene tree and asset
 * metadata, then modify `.tscn`/scripts with the ordinary filesystem tools.
 * @module @deepseek-ai/dsh-tool-game
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: resolves ctx.gameRuntimes for this package's program.
import { GameError } from '@deepseek-ai/dsh-game-runtime'
import type { SceneNode } from '@deepseek-ai/dsh-game-runtime'

export const name = 'tool-game'
export const inject = ['tools', 'gameRuntimes']

/** Stable tool names, exported for e2e assertions and catalogs. */
export const GAME_BUILD_TOOL = 'game_build'
export const GAME_RUN_TOOL = 'game_run'
export const GAME_READ_LOG_TOOL = 'game_read_log'
export const GAME_QUERY_SCENE_TOOL = 'game_query_scene'
export const GAME_QUERY_ASSET_TOOL = 'game_query_asset'
export const GAME_CAPTURE_FRAME_TOOL = 'game_capture_frame'

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

  ctx.tools.register(defineTool({
    name: GAME_QUERY_SCENE_TOOL,
    description: 'Query the node tree of a game engine scene (the main scene when scenePath is omitted). Returns every node with its path, engine type, and name — the declared or live structure the engine reports — to guide .tscn/script refactors.',
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
      scenePath: {
        type: 'string',
        description: 'Scene resource path to query (e.g. res://main.tscn). Omitted = the project main scene.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scenePath: { type: 'string', required: true },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                type: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `game_query_scene: ${value.scenePath}\n${value.nodes.map((node: SceneEntry) => `${node.path} (${node.type})`).join('\n')}`,
      }],
    },
    async execute(args, exec) {
      const info = await ctx.gameRuntimes.queryScene({
        ...args.engine !== undefined ? { engine: args.engine } : {},
        project: args.project,
        ...args.scenePath !== undefined ? { scenePath: args.scenePath } : {},
      })
      exec.signal.throwIfAborted()
      const nodes: SceneEntry[] = []
      flattenSceneNode(info.root, nodes)
      return { scenePath: info.scenePath, nodes }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Query scene ${args.scenePath ?? 'main'}`,
      kind: 'read',
      rawInput: { project: args.project, scenePath: args.scenePath ?? '' },
    }),
  }))

  ctx.tools.register(defineTool({
    name: GAME_QUERY_ASSET_TOOL,
    description: 'Query one project asset: whether it exists, its derived kind, size, and — for .tscn scenes and GDScript files — the declared node skeleton or script header. Feeds the refactor loop before editing the file with the filesystem tools.',
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
      assetPath: {
        type: 'string',
        required: true,
        description: 'Project-relative asset path (e.g. res://main.tscn, player/player.gd); absolute or escaping paths are rejected.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          assetPath: { type: 'string', required: true },
          exists: { type: 'boolean', required: true },
          kind: { type: 'string', required: true, enum: ['scene', 'script', 'texture', 'audio', 'font', 'shader', 'config', 'other'] },
          bytes: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                parent: { type: 'string', required: true },
              },
            },
          },
          extends: { type: 'string' },
          className: { type: 'string' },
          tool: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderAssetQuery(value),
      }],
    },
    async execute(args, exec) {
      const info = await ctx.gameRuntimes.queryAsset({
        ...args.engine !== undefined ? { engine: args.engine } : {},
        project: args.project,
        assetPath: args.assetPath,
      })
      exec.signal.throwIfAborted()
      return {
        assetPath: info.assetPath,
        exists: info.exists,
        kind: info.kind,
        bytes: info.bytes ?? null,
        ...info.tscn !== undefined ? { nodes: [...info.tscn.nodes] } : {},
        ...info.script?.extends !== undefined ? { extends: info.script.extends } : {},
        ...info.script?.className !== undefined ? { className: info.script.className } : {},
        ...info.script !== undefined ? { tool: info.script.tool } : {},
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Query asset ${args.assetPath}`,
      kind: 'read',
      rawInput: { project: args.project, assetPath: args.assetPath },
    }),
  }))
}

/** One flattened scene node row in the model-facing output. */
interface SceneEntry {
  path: string
  type: string
  name: string
}

/** Flatten a nested scene tree into file-order rows. */
function flattenSceneNode(node: SceneNode, into: SceneEntry[]): void {
  into.push({ path: node.path, type: node.type, name: node.name })
  for (const child of node.children) flattenSceneNode(child, into)
}

/** One model-facing asset-query summary line. */
function renderAssetQuery(value: {
  assetPath: string
  exists: boolean
  kind: string
  bytes?: number | null
  nodes?: { name: string; type: string; parent: string }[]
  extends?: string
  className?: string
  tool?: boolean
}): string {
  if (!value.exists) return `game_query_asset: ${value.assetPath} does not exist.`
  const parts = [`game_query_asset: ${value.assetPath} is a ${value.kind}${value.bytes !== undefined && value.bytes !== null ? ` (${String(value.bytes)} bytes)` : ''}.`]
  if (value.kind === 'scene' && value.nodes !== undefined) {
    parts.push(`${value.nodes.length} declared node(s): ${value.nodes.map(node => `${node.name} (${node.type})`).join(', ')}.`)
  }
  if (value.kind === 'script') {
    if (value.extends !== undefined) parts.push(`extends ${value.extends}.`)
    if (value.className !== undefined) parts.push(`class_name ${value.className}.`)
    if (value.tool === true) parts.push('@tool.')
  }
  return parts.join(' ')
}
