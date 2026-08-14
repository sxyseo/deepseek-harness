import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import GameRuntimeRegistry from '@deepseek-ai/dsh-game-runtime'
import * as godotProvider from '@deepseek-ai/dsh-game-runtime-godot'
import { GODOT_ENGINE_ID, GodotRuntime, type GodotRuntimeConfig } from '@deepseek-ai/dsh-game-runtime-godot'

const shimPath = fileURLToPath(new URL('./fixtures/godot-shim.mjs', import.meta.url))

/**
 * Provider config that drives the real GodotRuntime through the real subprocess
 * seam using a Node-run engine shim: `argvPrefix` puts the script right after
 * the executable (`node <shim> --headless --path ...`), which is also the
 * production wrapper shape (flatpak, snap, custom launchers).
 */
const shimConfig: GodotRuntimeConfig = { godotExecutable: process.execPath, argvPrefix: [shimPath] }

async function mount(config: GodotRuntimeConfig = {}): Promise<{ ctx: Context; runtime: GodotRuntime; project: string }> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(GameRuntimeRegistry)
  const runtime = new GodotRuntime(ctx, config)
  ctx.gameRuntimes.register(GODOT_ENGINE_ID, runtime)
  const project = await mkdtemp(join(tmpdir(), 'dsh-godot-project-'))
  return { ctx, runtime, project }
}

/** Poll until the process log contains the marker or the deadline passes. */
async function waitForLog(process: { readLog(): { text: string } }, marker: string, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (process.readLog().text.includes(marker)) return
    await sleepMs(20)
  }
  throw new Error(`log marker never appeared: ${JSON.stringify(marker)}; log: ${process.readLog().text}`)
}

describe('GodotRuntime spec resolution', () => {
  it('resolves a run request into the headless run argv', async () => {
    const { runtime, project } = await mount({ godotExecutable: '/opt/godot/godot' })
    const spec = runtime.resolve({ project, args: ['--fixed-fps', '60'] })
    expect(spec.engine).toBe('godot')
    expect(spec.projectPath).toBe(resolve(project))
    expect(spec.argv.slice(0, 4)).toEqual(['/opt/godot/godot', '--headless', '--path', resolve(project)])
    expect(spec.argv.slice(4)).toEqual(['--fixed-fps', '60'])
    expect(spec.cwd).toBe(resolve(project))
    await rm(project, { recursive: true, force: true })
  })

  it('inserts the wrapper argvPrefix directly after the executable', async () => {
    const { runtime, project } = await mount({ godotExecutable: 'flatpak', argvPrefix: ['run', 'org.godotengine.Godot'] })
    const spec = runtime.resolve({ project })
    expect(spec.argv.slice(0, 6)).toEqual(['flatpak', 'run', 'org.godotengine.Godot', '--headless', '--path', resolve(project)])
    await rm(project, { recursive: true, force: true })
  })

  it('resolves a build request into --import plus an optional export preset', async () => {
    const { runtime, project } = await mount()
    const importOnly = runtime.resolveBuild({ project })
    expect(importOnly.argv).toEqual(['godot', '--headless', '--path', resolve(project), '--import'])
    expect(importOnly.outputPath).toBeUndefined()

    const exported = runtime.resolveBuild({ project, exportPreset: 'Web' })
    expect(exported.argv.slice(-4)).toEqual(['--import', '--export-release', 'Web', join(resolve(project), 'dist', 'Web')])
    expect(exported.outputPath).toBe(join(resolve(project), 'dist', 'Web'))
    await rm(project, { recursive: true, force: true })
  })

  it('rejects an empty or missing project path', async () => {
    const { runtime, project } = await mount()
    expect(() => runtime.resolve({ project: '  ' })).toThrow(expect.objectContaining({ code: 'GAME_INVALID_REQUEST' }))
    expect(() => runtime.resolve({ project: join(project, 'does-not-exist') })).toThrow(expect.objectContaining({ code: 'GAME_INVALID_REQUEST' }))
    await rm(project, { recursive: true, force: true })
  })
})

describe('GodotRuntime builds through the subprocess seam', () => {
  it('runs a headless import and reports the exit-zero outcome', async () => {
    const { ctx, runtime, project } = await mount(shimConfig)
    try {
      const result = await runtime.build(runtime.resolveBuild({ project }))
      expect(result).toMatchObject({ engine: 'godot', ok: true, exitCode: 0 })
      expect(result.log.text).toContain('SHIM: import finished')
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('reports a non-zero build exit as a result, not a rejection', async () => {
    const { ctx, runtime, project } = await mount(shimConfig)
    try {
      const result = await runtime.build(runtime.resolveBuild({ project, env: { SHIM_IMPORT_EXIT: '3' } }))
      expect(result).toMatchObject({ ok: false, exitCode: 3 })
      expect(result.log.text).toContain('SHIM: import finished')
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('runs the export preset and returns the artifact path', async () => {
    const { ctx, runtime, project } = await mount(shimConfig)
    try {
      const output = join(resolve(project), 'dist', 'Web')
      const result = await runtime.build(runtime.resolveBuild({ project, exportPreset: 'Web' }))
      expect(result).toMatchObject({ ok: true, outputPath: output })
      expect(result.log.text).toContain('SHIM: exported preset Web')
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('wraps a missing executable in GAME_EXECUTABLE_MISSING', async () => {
    const missingDir = await mkdtemp(join(tmpdir(), 'dsh-godot-missing-'))
    const { ctx, runtime, project } = await mount({ godotExecutable: join(resolve(missingDir), 'no-such-godot-binary') })
    try {
      await expect(runtime.build(runtime.resolveBuild({ project })))
        .rejects.toThrow(expect.objectContaining({ code: 'GAME_EXECUTABLE_MISSING' }))
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
      await rm(missingDir, { recursive: true, force: true })
    }
  })
})

describe('GodotRuntime live processes', () => {
  it('starts a tracked process, reads its log, and terminates the tree', async () => {
    const { ctx, runtime, project } = await mount(shimConfig)
    try {
      const process = await runtime.start(runtime.resolve({ project }))
      expect(process.info()).toMatchObject({ engine: 'godot', state: 'running' })
      await waitForLog(process, 'SHIM: running project')
      process.terminate()
      await expect(process.outcome).resolves.toBeDefined()
      expect(process.info().state).toBe('exited')
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('declares the not-yet-implemented observation/input capabilities honestly', async () => {
    const { runtime, project } = await mount()
    await expect(runtime.captureFrame({ projectPath: project, outputPath: 'o.png' }))
      .rejects.toThrow(expect.objectContaining({ code: 'GAME_CAPABILITY_UNAVAILABLE' }))
    await expect(runtime.queryScene({ projectPath: project }))
      .rejects.toThrow(expect.objectContaining({ code: 'GAME_CAPABILITY_UNAVAILABLE' }))
    await expect(runtime.sendInput({ processId: 'game-x', action: 'key_press' }))
      .rejects.toThrow(expect.objectContaining({ code: 'GAME_CAPABILITY_UNAVAILABLE' }))
    await rm(project, { recursive: true, force: true })
  })
})

describe('game-runtime-godot plugin wiring', () => {
  it('registers the real GodotRuntime under the godot engine id', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(GameRuntimeRegistry)
    await ctx.plugin(godotProvider, { godotExecutable: 'godot' })
    expect(ctx.gameRuntimes.names()).toEqual(['godot'])
    const runtime = ctx.gameRuntimes.resolve({ engine: 'godot' })
    expect(runtime).toBeInstanceOf(GodotRuntime)
    await ctx.fiber.dispose()
  })
})
