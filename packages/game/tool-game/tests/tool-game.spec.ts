import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import GameRuntimeRegistry, {
  EngineRuntime,
  type AssetInfo,
  type AssetQueryRequest,
  type AssetQuerySpec,
  type GameBuildRequest,
  type GameBuildSpec,
  type GameFrame,
  type GameLogText,
  type GameProcess,
  type GameProcessInfo,
  type GameProcessOutcome,
  type GameRunRequest,
  type GameRunSpec,
  type InputResult,
  type InputSpec,
  type CaptureRequest,
  type CaptureSpec,
  type SceneInfo,
  type SceneQueryRequest,
  type SceneQuerySpec,
} from '@deepseek-ai/dsh-game-runtime'

import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** A scripted engine backend so tool behavior is testable without an engine binary. */
class FakeRuntime extends EngineRuntime {
  readonly built: GameBuildRequest[] = []
  readonly started: GameProcess[] = []

  constructor() {
    super('fake')
  }

  override resolve(request: GameRunRequest): GameRunSpec {
    return { engine: this.engine, projectPath: request.project, argv: ['fake', '--headless', '--path', request.project], cwd: request.project, graceMs: 1000 }
  }

  override resolveBuild(request: GameBuildRequest): GameBuildSpec {
    return { engine: this.engine, projectPath: request.project, argv: ['fake', '--build', '--path', request.project], cwd: request.project, graceMs: 1000 }
  }

  override async build(spec: GameBuildSpec): Promise<{ engine: string; ok: boolean; exitCode: number | null; log: GameLogText }> {
    return { engine: spec.engine, ok: true, exitCode: 0, log: { text: `fake built ${spec.projectPath}`, truncated: false } }
  }

  override async start(spec: GameRunSpec): Promise<GameProcess> {
    let settled = false
    const processId = `game-fake-${this.started.length}`
    const pid = 100 + this.started.length
    const outcome = new Promise<GameProcessOutcome>(() => {})
    const process: GameProcess = {
      processId,
      engine: this.engine,
      info(): GameProcessInfo {
        return { processId, engine: 'fake', pid, state: settled ? 'exited' : 'running', exitCode: null }
      },
      outcome,
      readLog(): GameLogText {
        return { text: `fake running ${spec.projectPath}`, truncated: false }
      },
      terminate(): void {
        settled = true
      },
      waitForExit: async (): Promise<boolean> => true,
    }
    this.started.push(process)
    return process
  }

  override async captureFrame(spec: CaptureSpec): Promise<GameFrame> {
    return { imagePath: spec.outputPath, width: 64, height: 48 }
  }

  override resolveCapture(request: CaptureRequest): CaptureSpec {
    return { projectPath: request.project, outputPath: request.outputPath }
  }

  override resolveSceneQuery(request: SceneQueryRequest): SceneQuerySpec {
    return {
      projectPath: request.project,
      ...request.scenePath !== undefined ? { scenePath: request.scenePath } : {},
    }
  }

  override resolveAssetQuery(request: AssetQueryRequest): AssetQuerySpec {
    return { projectPath: request.project, assetPath: request.assetPath }
  }

  override async queryScene(spec: SceneQuerySpec): Promise<SceneInfo> {
    return {
      scenePath: spec.scenePath ?? 'res://main.tscn',
      root: {
        path: 'Main',
        type: 'Node2D',
        name: 'Main',
        children: [
          { path: 'Main/Player', type: 'CharacterBody2D', name: 'Player', children: [] },
          { path: 'Main/World', type: 'Node2D', name: 'World', children: [] },
        ],
      },
    }
  }

  override async queryAsset(spec: AssetQuerySpec): Promise<AssetInfo> {
    if (spec.assetPath === 'res://main.tscn') {
      return {
        assetPath: spec.assetPath,
        exists: true,
        kind: 'scene',
        bytes: 42,
        tscn: {
          root: 'Main',
          nodes: [
            { name: 'Main', type: 'Node2D', parent: '.' },
            { name: 'Player', type: 'CharacterBody2D', parent: 'Main' },
          ],
        },
      }
    }
    return { assetPath: spec.assetPath, exists: false, kind: 'other' }
  }

  override async sendInput(_spec: InputSpec): Promise<InputResult> {
    throw new Error('unused')
  }
}

async function setup(): Promise<{ ctx: Context; runtime: FakeRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(GameRuntimeRegistry)
  const runtime = new FakeRuntime()
  ctx.gameRuntimes.register('fake', runtime)
  await ctx.plugin(tool)
  return { ctx, runtime }
}

let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown): Promise<{
  isError: boolean
  value?: Record<string, unknown>
  error?: { message: string; info?: { name?: string; code?: string } }
}> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
  }) as Promise<{ isError: boolean; value?: Record<string, unknown>; error?: { message: string; info?: { name?: string; code?: string } } }>
}

describe('dsh-tool-game registration', () => {
  it('registers the five game tools with an optional engine field', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas()
    for (const name of ['game_build', 'game_run', 'game_read_log', 'game_query_scene', 'game_query_asset']) {
      expect(schemas.some(entry => entry.name === name), name).toBe(true)
    }
    const build = schemas.find(entry => entry.name === 'game_build')
    const readLog = schemas.find(entry => entry.name === 'game_read_log')
    const queryScene = schemas.find(entry => entry.name === 'game_query_scene')
    const queryAsset = schemas.find(entry => entry.name === 'game_query_asset')
    const buildParams = build!.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(buildParams.required).toContain('project')
    expect(buildParams.required).not.toContain('engine')
    expect(Object.keys(buildParams.properties)).toContain('engine')
    const readParams = readLog!.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(readParams.required).toContain('processId')
    expect(readParams.required).not.toContain('engine')
    const sceneParams = queryScene!.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(sceneParams.required).toContain('project')
    expect(sceneParams.required).not.toContain('scenePath')
    const assetParams = queryAsset!.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(assetParams.required).toEqual(['project', 'assetPath'])
  })
})

describe('game_build', () => {
  it('routes through the single registered engine and returns the build outcome', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'game_build', { project: 'games/2048' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ engine: 'fake', ok: true, exitCode: 0 })
    expect((result.value?.log as { text: string }).text).toContain('fake built')
  })

  it('is an error when no engine is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(GameRuntimeRegistry)
    await ctx.plugin(tool)
    const result = await callTool(ctx, 'game_build', { project: 'games/2048' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('GAME_ENGINE_UNAVAILABLE')
  })
})

describe('dsh-tool-game HMR safety', () => {
  it('unregisters the five tools when the contributing fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(GameRuntimeRegistry)
    const fiber = await ctx.plugin(tool)
    const registered = (): boolean => ctx.tools.schemas().some(entry => entry.name.startsWith('game_'))
    expect(registered()).toBe(true)
    await fiber.dispose()
    expect(registered()).toBe(false)
  })
})

describe('game_run / game_read_log', () => {
  it('starts a tracked process and reads its log back', async () => {
    const { ctx, runtime } = await setup()
    const started = await callTool(ctx, 'game_run', { project: 'games/2048' })
    expect(started.isError, String(started.error?.message)).toBe(false)
    expect(started.value).toMatchObject({ engine: 'fake', pid: 100 })
    expect(runtime.started).toHaveLength(1)

    const log = await callTool(ctx, 'game_read_log', { processId: started.value?.processId })
    expect(log.isError).toBe(false)
    expect(log.value).toMatchObject({ engine: 'fake', state: 'running', exitCode: null })
    expect((log.value?.log as { text: string }).text).toContain('fake running')
  })

  it('reports an unknown process id as an error', async () => {
    const { ctx } = await setup()
    const log = await callTool(ctx, 'game_read_log', { processId: 'nope' })
    expect(log.isError).toBe(true)
    expect(log.error?.info?.code).toBe('GAME_PROCESS_UNKNOWN')
  })
})

describe('game_query_scene', () => {
  it('returns the flattened node tree', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'game_query_scene', { project: 'games/2048', scenePath: 'res://main.tscn' })
    expect(result.isError, String(result.error?.message)).toBe(false)
    expect(result.value).toMatchObject({ scenePath: 'res://main.tscn' })
    expect(result.value?.nodes).toEqual([
      { path: 'Main', type: 'Node2D', name: 'Main' },
      { path: 'Main/Player', type: 'CharacterBody2D', name: 'Player' },
      { path: 'Main/World', type: 'Node2D', name: 'World' },
    ])
    const content = result.value as { nodes: unknown[] }
    expect(content.nodes).toHaveLength(3)
  })
})

describe('game_query_asset', () => {
  it('returns the declared .tscn skeleton', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'game_query_asset', { project: 'games/2048', assetPath: 'res://main.tscn' })
    expect(result.isError, String(result.error?.message)).toBe(false)
    expect(result.value).toMatchObject({ assetPath: 'res://main.tscn', exists: true, kind: 'scene', bytes: 42 })
    expect(result.value?.nodes).toEqual([
      { name: 'Main', type: 'Node2D', parent: '.' },
      { name: 'Player', type: 'CharacterBody2D', parent: 'Main' },
    ])
  })

  it('reports a missing asset with exists: false', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'game_query_asset', { project: 'games/2048', assetPath: 'missing.png' })
    expect(result.isError, String(result.error?.message)).toBe(false)
    expect(result.value).toMatchObject({ assetPath: 'missing.png', exists: false, kind: 'other', bytes: null })
  })
})
