import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GameRuntimeRegistry, {
  EngineRuntime,
  GameError,
  MAX_RETAINED_EXITED_PROCESSES,
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

let processSerial = 0

/** Build one scripted fake process whose outcome the test settles by hand. */
function makeFakeProcess(engine: string, logLines: string[] = []): {
  process: GameProcess
  exit: (exitCode: number | null, signal?: NodeJS.Signals | null) => void
} {
  const processId = `game-fake-${engine}-${processSerial++}`
  let settled = false
  let exitCode: number | null = null
  let settleOutcome!: (outcome: GameProcessOutcome) => void
  const outcome = new Promise<GameProcessOutcome>((resolve) => { settleOutcome = resolve })
  const exit = (code: number | null, signal: NodeJS.Signals | null = null): void => {
    if (settled) return
    settled = true
    exitCode = code
    settleOutcome({ exitCode: code, signal })
  }
  const process: GameProcess = {
    processId,
    engine,
    info(): GameProcessInfo {
      return { processId, engine, pid: 4242, state: settled ? 'exited' : 'running', exitCode: settled ? exitCode : null }
    },
    outcome,
    readLog(): GameLogText {
      return { text: logLines.join('\n'), truncated: false }
    },
    terminate(): void {
      exit(143, 'SIGTERM')
    },
    waitForExit: async (abort?: AbortSignal): Promise<boolean> => {
      if (abort?.aborted) return false
      return settled
    },
  }
  return { process, exit }
}

/** A scripted engine backend for contract tests. */
class FakeRuntime extends EngineRuntime {
  readonly started: { process: GameProcess; exit: (exitCode: number | null, signal?: NodeJS.Signals | null) => void }[] = []

  override resolve(request: GameRunRequest): GameRunSpec {
    return {
      engine: this.engine,
      projectPath: request.project,
      argv: ['fake-engine', '--headless', '--path', request.project, ...(request.args ?? [])],
      cwd: request.cwd ?? request.project,
      graceMs: 1000,
    }
  }

  override resolveBuild(request: GameBuildRequest): GameBuildSpec {
    return {
      engine: this.engine,
      projectPath: request.project,
      argv: ['fake-engine', '--build', '--path', request.project],
      cwd: request.project,
      graceMs: 1000,
    }
  }

  override async build(spec: GameBuildSpec): Promise<{ engine: string; ok: boolean; exitCode: number | null; log: GameLogText }> {
    return { engine: spec.engine, ok: true, exitCode: 0, log: { text: 'fake build ok', truncated: false } }
  }

  override async start(spec: GameRunSpec): Promise<GameProcess> {
    const record = makeFakeProcess(this.engine, [`fake running ${spec.projectPath}`])
    this.started.push(record)
    return record.process
  }

  override async captureFrame(_spec: CaptureSpec): Promise<GameFrame> {
    throw new GameError(`engine "${this.engine}" has not implemented frame capture yet`, 'GAME_CAPABILITY_UNAVAILABLE')
  }

  override async queryScene(_spec: SceneQuerySpec): Promise<SceneInfo> {
    throw new GameError(`engine "${this.engine}" has not implemented scene queries yet`, 'GAME_CAPABILITY_UNAVAILABLE')
  }

  override async sendInput(_spec: InputSpec): Promise<InputResult> {
    throw new GameError(`engine "${this.engine}" has not implemented input yet`, 'GAME_CAPABILITY_UNAVAILABLE')
  }
}

/** Mount the registry on a fresh root context with the given config. */
async function mount(config: ConstructorParameters<typeof GameRuntimeRegistry>[1] = {}): Promise<{ ctx: Context; registry: GameRuntimeRegistry; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(GameRuntimeRegistry, config)
  return { ctx, registry: ctx.gameRuntimes, fiber }
}

describe('GameRuntimeRegistry registration', () => {
  it('registers a runtime under its engine name and unregisters it via the returned disposer', async () => {
    const { registry } = await mount()
    const dispose = registry.register('godot', new FakeRuntime('godot'))
    expect(registry.names()).toEqual(['godot'])
    dispose()
    expect(registry.names()).toEqual([])
    await expect(registry.build({ project: 'p' })).rejects.toThrow(expect.objectContaining({ code: 'GAME_ENGINE_UNAVAILABLE' }))
  })

  it('throws GAME_DUPLICATE_RUNTIME on a duplicate engine name', async () => {
    const { registry } = await mount()
    registry.register('godot', new FakeRuntime('godot'))
    expect(() => registry.register('godot', new FakeRuntime('godot')))
      .toThrow(expect.objectContaining({ code: 'GAME_DUPLICATE_RUNTIME' }))
  })

  it('disposes runtime registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, registry } = await mount()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.gameRuntimes.register('godot', new FakeRuntime('godot'))
    }, { inject: ['gameRuntimes'] }))
    expect(registry.names()).toEqual(['godot'])
    await fiber.dispose()
    expect(registry.names()).toEqual([])
  })
})

describe('GameRuntimeRegistry engine resolution', () => {
  it('throws GAME_ENGINE_UNAVAILABLE when nothing is registered', async () => {
    const { registry } = await mount()
    await expect(registry.build({ project: 'p' })).rejects.toThrow(expect.objectContaining({ code: 'GAME_ENGINE_UNAVAILABLE' }))
  })

  it('throws GAME_ENGINE_UNKNOWN for an unregistered explicit engine', async () => {
    const { registry } = await mount()
    registry.register('godot', new FakeRuntime('godot'))
    await expect(registry.build({ engine: 'unity', project: 'p' })).rejects.toThrow(expect.objectContaining({ code: 'GAME_ENGINE_UNKNOWN' }))
  })

  it('throws GAME_ENGINE_AMBIGUOUS rather than picking by registration order', async () => {
    const { registry } = await mount()
    registry.register('godot', new FakeRuntime('godot'))
    registry.register('unity', new FakeRuntime('unity'))
    await expect(registry.build({ project: 'p' })).rejects.toThrow(expect.objectContaining({ code: 'GAME_ENGINE_AMBIGUOUS' }))
  })

  it('auto-selects the single registered engine when no engine is requested', async () => {
    const { registry } = await mount()
    registry.register('godot', new FakeRuntime('godot'))
    await expect(registry.build({ project: 'p' })).resolves.toMatchObject({ engine: 'godot', ok: true })
  })

  it('uses the configured default engine even when several are registered', async () => {
    const { registry } = await mount({ defaultEngine: 'unity' })
    registry.register('godot', new FakeRuntime('godot'))
    registry.register('unity', new FakeRuntime('unity'))
    await expect(registry.build({ project: 'p' })).resolves.toMatchObject({ engine: 'unity' })
  })

  it('throws GAME_ENGINE_UNKNOWN for an unregistered configured default', async () => {
    const { registry } = await mount({ defaultEngine: 'unreal' })
    registry.register('godot', new FakeRuntime('godot'))
    await expect(registry.build({ project: 'p' })).rejects.toThrow(expect.objectContaining({ code: 'GAME_ENGINE_UNKNOWN' }))
  })

  it('lets an explicit per-call engine override the configured default', async () => {
    const { registry } = await mount({ defaultEngine: 'unity' })
    registry.register('godot', new FakeRuntime('godot'))
    registry.register('unity', new FakeRuntime('unity'))
    await expect(registry.build({ engine: 'godot', project: 'p' })).resolves.toMatchObject({ engine: 'godot' })
  })
})

describe('GameRuntimeRegistry process tracking', () => {
  it('starts, tracks, and reads the log of one process', async () => {
    const { registry } = await mount()
    registry.register('godot', new FakeRuntime('godot'))
    const process = await registry.start({ project: 'p' })
    expect(process.info()).toMatchObject({ state: 'running', engine: 'godot' })
    expect(registry.readLog({ processId: process.processId }).text).toContain('fake running p')
  })

  it('throws GAME_PROCESS_UNKNOWN for an unknown process id', async () => {
    const { registry } = await mount()
    registry.register('godot', new FakeRuntime('godot'))
    expect(() => registry.readLog({ processId: 'nope' })).toThrow(expect.objectContaining({ code: 'GAME_PROCESS_UNKNOWN' }))
  })

  it('throws GAME_PROCESS_UNKNOWN when the readLog engine disagrees with the process engine', async () => {
    const { registry } = await mount()
    registry.register('godot', new FakeRuntime('godot'))
    const process = await registry.start({ project: 'p' })
    expect(() => registry.readLog({ processId: process.processId, engine: 'unity' }))
      .toThrow(expect.objectContaining({ code: 'GAME_PROCESS_UNKNOWN' }))
  })

  it('stop() terminates the tracked tree and keeps the record for a final log read', async () => {
    const { registry } = await mount()
    registry.register('godot', new FakeRuntime('godot'))
    const process = await registry.start({ project: 'p' })
    registry.stop(process.processId)
    await process.outcome
    expect(process.info().state).toBe('exited')
    expect(() => registry.readLog({ processId: process.processId })).not.toThrow()
  })

  it('terminates every tracked process when the registry fiber disposes', async () => {
    const { fiber, registry } = await mount()
    registry.register('godot', new FakeRuntime('godot'))
    const process = await registry.start({ project: 'p' })
    expect(process.info().state).toBe('running')
    await fiber.dispose()
    await expect(process.outcome).resolves.toMatchObject({ exitCode: 143 })
    expect(process.info().state).toBe('exited')
  })

  it('evicts the oldest exited record past the retention cap', async () => {
    const { registry } = await mount()
    const runtime = new FakeRuntime('godot')
    registry.register('godot', runtime)
    const processes: GameProcess[] = []
    for (let index = 0; index < MAX_RETAINED_EXITED_PROCESSES + 2; index++) {
      const process = await registry.start({ project: 'p' })
      processes.push(process)
      // Exit each process before the next start so the tracker observes it as
      // exited and applies the cap.
      runtime.started.at(-1)?.exit(0)
      await process.outcome
    }
    // The cap keeps MAX_RETAINED_EXITED_PROCESSES exited records; the final
    // process is still running, so the single oldest exited record was evicted.
    const oldest = processes[0]
    const second = processes[1]
    const newest = processes[processes.length - 1]
    if (oldest === undefined || second === undefined || newest === undefined) throw new Error('fixture processes missing')
    expect(() => registry.readLog({ processId: oldest.processId })).toThrow(expect.objectContaining({ code: 'GAME_PROCESS_UNKNOWN' }))
    expect(() => registry.readLog({ processId: second.processId })).not.toThrow()
    expect(() => registry.readLog({ processId: newest.processId })).not.toThrow()
  })
})

describe('GameError', () => {
  it('is a HarnessError carrying its code', () => {
    const error = new GameError('boom', 'GAME_ENGINE_AMBIGUOUS')
    expect(error.code).toBe('GAME_ENGINE_AMBIGUOUS')
    expect(error.name).toBe('GameError')
  })
})
