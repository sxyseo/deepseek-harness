import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import GameRuntimeRegistry, {
  EngineRuntime,
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
  type CaptureSpec,
  type SceneInfo,
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

  override async captureFrame(_spec: CaptureSpec): Promise<GameFrame> {
    throw new Error('unused')
  }

  override async queryScene(_spec: SceneQuerySpec): Promise<SceneInfo> {
    throw new Error('unused')
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
  it('registers game_build, game_run, and game_read_log with an optional engine field', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas()
    const build = schemas.find(entry => entry.name === 'game_build')
    const run = schemas.find(entry => entry.name === 'game_run')
    const readLog = schemas.find(entry => entry.name === 'game_read_log')
    expect(build).toBeDefined()
    expect(run).toBeDefined()
    expect(readLog).toBeDefined()
    const buildParams = build!.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(buildParams.required).toContain('project')
    expect(buildParams.required).not.toContain('engine')
    expect(Object.keys(buildParams.properties)).toContain('engine')
    const readParams = readLog!.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(readParams.required).toContain('processId')
    expect(readParams.required).not.toContain('engine')
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
  it('unregisters the three tools when the contributing fiber disposes', async () => {
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
