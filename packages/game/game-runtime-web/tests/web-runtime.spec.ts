import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import GameRuntimeRegistry from '@deepseek-ai/dsh-game-runtime'
import * as webProvider from '@deepseek-ai/dsh-game-runtime-web'
import { WEB_ENGINE_ID, WebRuntime, type WebRuntimeConfig } from '@deepseek-ai/dsh-game-runtime-web'

const viteEntryShim = fileURLToPath(new URL('./fixtures/vite-entry.mjs', import.meta.url))
const browserShim = fileURLToPath(new URL('./fixtures/browser-shim.mjs', import.meta.url))

/**
 * Provider config that drives the real WebRuntime through the real subprocess
 * seam: the browser is a Node-run shim (`browserArgvPrefix` puts the script
 * right after the executable), while builds, runs, and the serve probe run
 * real Node against the test project's fake local Vite.
 */
const browserShimConfig: WebRuntimeConfig = { browserExecutable: process.execPath, browserArgvPrefix: [browserShim] }

async function mount(config: WebRuntimeConfig = {}): Promise<{ ctx: Context; runtime: WebRuntime; project: string }> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(GameRuntimeRegistry)
  const runtime = new WebRuntime(ctx, config)
  ctx.gameRuntimes.register(WEB_ENGINE_ID, runtime)
  const project = await mkdtemp(join(tmpdir(), 'dsh-web-project-'))
  return { ctx, runtime, project }
}

/** Give the test project a fake project-local Vite CLI. */
async function installViteShim(project: string): Promise<void> {
  await mkdir(join(project, 'node_modules', 'vite', 'bin'), { recursive: true })
  await copyFile(viteEntryShim, join(project, 'node_modules', 'vite', 'bin', 'vite.js'))
}

/** Poll until the process log contains the marker or the deadline passes. */
async function waitForLog(process: { readLog(): { text: string } }, marker: string, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (process.readLog().text.includes(marker)) return
    await sleepMs(20)
  }
  throw new Error(`log marker never appeared: ${JSON.stringify(marker)}; log: ${process.readLog().text}`)
}

describe('WebRuntime spec resolution', () => {
  it('resolves a run request into the vite preview argv', async () => {
    const { runtime, project } = await mount()
    try {
      await installViteShim(project)
      const spec = runtime.resolve({ project, args: ['--mode', 'production'] })
      expect(spec.engine).toBe('web')
      expect(spec.projectPath).toBe(resolve(project))
      expect(spec.argv.slice(0, 6)).toEqual([
        process.execPath, join(resolve(project), 'node_modules/vite/bin/vite.js'),
        'preview', '--port', '4173', '--strictPort',
      ])
      expect(spec.argv.slice(6)).toEqual(['--mode', 'production'])
      expect(spec.cwd).toBe(resolve(project))
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('resolves a build request into the vite build argv with a dist artifact', async () => {
    const { runtime, project } = await mount({ previewPort: 5173 })
    try {
      await installViteShim(project)
      const spec = runtime.resolveBuild({ project })
      expect(spec.argv).toEqual([
        process.execPath, join(resolve(project), 'node_modules/vite/bin/vite.js'), 'build',
      ])
      expect(spec.outputPath).toBe(join(resolve(project), 'dist'))

      const custom = runtime.resolveBuild({ project, outputPath: join(project, 'out') })
      expect(custom.outputPath).toBe(join(project, 'out'))
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('rejects export presets, and empty or missing project paths', async () => {
    const { runtime, project } = await mount()
    try {
      expect(() => runtime.resolveBuild({ project, exportPreset: 'Web' }))
        .toThrow(expect.objectContaining({ code: 'GAME_INVALID_REQUEST' }))
      expect(() => runtime.resolve({ project: '  ' })).toThrow(expect.objectContaining({ code: 'GAME_INVALID_REQUEST' }))
      expect(() => runtime.resolve({ project: join(project, 'does-not-exist') })).toThrow(expect.objectContaining({ code: 'GAME_INVALID_REQUEST' }))
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe('WebRuntime builds through the subprocess seam', () => {
  it('runs the project-local vite build and reports the exit-zero outcome', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      await installViteShim(project)
      const result = await runtime.build(runtime.resolveBuild({ project }))
      expect(result).toMatchObject({ engine: 'web', ok: true, exitCode: 0, outputPath: join(resolve(project), 'dist') })
      expect(result.log.text).toContain('WEB_SHIM: vite build')
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('reports a non-zero build exit as a result, not a rejection', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      await installViteShim(project)
      const result = await runtime.build(runtime.resolveBuild({ project, env: { WEB_SHIM_BUILD_EXIT: '3' } }))
      expect(result).toMatchObject({ ok: false, exitCode: 3 })
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('wraps a missing local vite in GAME_EXECUTABLE_MISSING', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      await expect(runtime.build(runtime.resolveBuild({ project })))
        .rejects.toThrow(expect.objectContaining({ code: 'GAME_EXECUTABLE_MISSING' }))
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe('WebRuntime live processes', () => {
  it('starts a tracked preview process, reads its log, and terminates the tree', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      await installViteShim(project)
      const process = await runtime.start(runtime.resolve({ project }))
      expect(process.info()).toMatchObject({ engine: 'web', state: 'running' })
      await waitForLog(process, 'WEB_SHIM: vite preview')
      process.terminate()
      await expect(process.outcome).resolves.toBeDefined()
      expect(process.info().state).toBe('exited')
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('declares the not-yet-implemented input capability honestly', async () => {
    const { runtime, project } = await mount()
    try {
      await expect(runtime.sendInput({ processId: 'game-x', action: 'key_press' }))
        .rejects.toThrow(expect.objectContaining({ code: 'GAME_CAPABILITY_UNAVAILABLE' }))
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe('WebRuntime scene queries', () => {
  it('parses the declared document structure of an html scene', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      await writeFile(join(project, 'index.html'), [
        '<!doctype html>',
        '<html>',
        '<head>',
        '  <title>Demo Game</title>',
        '  <link rel="stylesheet" href="/style.css">',
        '  <script src="/src/main.ts" type="module"></script>',
        '</head>',
        '<body>',
        '  <canvas id="game"></canvas>',
        '  <div id="hud"></div>',
        '</body>',
        '</html>',
        '',
      ].join('\n'))
      const info = await runtime.queryScene(runtime.resolveSceneQuery({ project }))
      expect(info.scenePath).toBe('index.html')
      expect(info.root).toMatchObject({ name: 'Demo Game', type: 'Document', path: '/index.html' })
      expect(info.root.children.map(child => `${child.type}:${child.name}`)).toEqual([
        'script:/src/main.ts',
        'stylesheet:/style.css',
        'canvas:game',
        'div:hud',
      ])
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('fails loud when the scene file does not exist', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      await expect(runtime.queryScene(runtime.resolveSceneQuery({ project, scenePath: 'missing.html' })))
        .rejects.toThrow(expect.objectContaining({ code: 'GAME_QUERY_FAILED' }))
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe('WebRuntime asset queries', () => {
  it('classifies html as a scene and parses a ts module header', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      await mkdir(join(project, 'src'), { recursive: true })
      await writeFile(join(project, 'src', 'GameScene.ts'), [
        "import { Scene } from '@game-cli/game-core'",
        'export class GameScene extends Scene {}',
        '',
      ].join('\n'))
      const scene = await runtime.queryAsset(runtime.resolveAssetQuery({ project, assetPath: 'src/GameScene.ts' }))
      expect(scene).toMatchObject({ assetPath: 'src/GameScene.ts', exists: true, kind: 'script' })
      expect(scene.script).toEqual({ className: 'GameScene', extends: 'Scene', tool: false })
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('reports a missing asset with exists: false, not a rejection', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      const info = await runtime.queryAsset(runtime.resolveAssetQuery({ project, assetPath: 'missing.png' }))
      expect(info).toMatchObject({ assetPath: 'missing.png', exists: false, kind: 'texture' })
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('rejects absolute or escaping asset paths', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      expect(() => runtime.resolveAssetQuery({ project, assetPath: join(project, 'index.html') }))
        .toThrow(expect.objectContaining({ code: 'GAME_INVALID_REQUEST' }))
      expect(() => runtime.resolveAssetQuery({ project, assetPath: '../outside.html' }))
        .toThrow(expect.objectContaining({ code: 'GAME_INVALID_REQUEST' }))
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe('WebRuntime frame captures through the subprocess seam', () => {
  it('serves the build output, screenshots it, and reports the PNG size', async () => {
    const { ctx, runtime, project } = await mount(browserShimConfig)
    try {
      await installViteShim(project)
      await mkdir(join(project, 'dist'), { recursive: true })
      await writeFile(join(project, 'dist', 'index.html'), '<!doctype html><title>Built</title>')
      const outputPath = join(project, 'frame.png')
      const frame = await runtime.captureFrame(runtime.resolveCapture({ project, outputPath, width: 64, height: 48 }))
      expect(frame.imagePath).toBe(outputPath)
      expect(frame).toMatchObject({ width: 1, height: 1 })
      const bytes = await readFile(outputPath)
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('resolves a relative capture output path against the project directory', async () => {
    const { ctx, runtime, project } = await mount(browserShimConfig)
    try {
      await mkdir(join(project, 'dist'), { recursive: true })
      await writeFile(join(project, 'dist', 'index.html'), '<!doctype html>')
      const frame = await runtime.captureFrame(runtime.resolveCapture({ project, outputPath: 'shots/frame.png' }))
      expect(frame.imagePath).toBe(join(resolve(project), 'shots', 'frame.png'))
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('fails loud when the browser exits non-zero', async () => {
    const { ctx, runtime, project } = await mount(browserShimConfig)
    try {
      await mkdir(join(project, 'dist'), { recursive: true })
      await writeFile(join(project, 'dist', 'index.html'), '<!doctype html>')
      const spec = { ...runtime.resolveCapture({ project, outputPath: join(project, 'frame.png') }), env: { WEB_SHIM_BROWSER_FAIL: '1' } }
      await expect(runtime.captureFrame(spec)).rejects.toThrow(expect.objectContaining({ code: 'GAME_CAPTURE_FAILED' }))
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('fails loud when there is no build output to serve', async () => {
    const { ctx, runtime, project } = await mount(browserShimConfig)
    try {
      await expect(runtime.captureFrame(runtime.resolveCapture({ project, outputPath: join(project, 'frame.png') })))
        .rejects.toThrow(expect.objectContaining({ code: 'GAME_CAPTURE_FAILED' }))
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('rejects an empty capture output path', async () => {
    const { ctx, runtime, project } = await mount()
    try {
      expect(() => runtime.resolveCapture({ project, outputPath: '  ' })).toThrow(expect.objectContaining({ code: 'GAME_INVALID_REQUEST' }))
    } finally {
      await ctx.fiber.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe('game-runtime-web plugin wiring', () => {
  it('registers the real WebRuntime under the web engine id', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(GameRuntimeRegistry)
    await ctx.plugin(webProvider, { browserExecutable: 'chrome' })
    expect(ctx.gameRuntimes.names()).toEqual(['web'])
    const runtime = ctx.gameRuntimes.resolve({ engine: 'web' })
    expect(runtime).toBeInstanceOf(WebRuntime)
    await ctx.fiber.dispose()
  })
})
