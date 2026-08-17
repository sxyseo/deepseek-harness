import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const binScript = fileURLToPath(new URL('../../../packages/examples/jsonrpc-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/jsonrpc.cordis.yml', import.meta.url))
const shimPath = fileURLToPath(new URL('./fixtures/godot-shim.mjs', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
// Resolve tsx from THIS module's context (repo node_modules): the child's cwd
// is the isolated temp root, where a bare `--import tsx` cannot resolve.
const tsxLoader = import.meta.resolve('tsx')

describe('game-agent JSON-RPC keyless smoke', () => {
  it('drives the full game round trip through the real SDK client over stdio (integration path A)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'game-agent-jsonrpc-'))
    await mkdir(join(root, 'game-project'), { recursive: true })
    await writeFile(join(root, 'game-project', 'main.tscn'), [
      '[gd_scene load_steps=2 format=3]',
      '',
      '[node name="Main" type="Node2D"]',
      '[node name="Player" type="CharacterBody2D" parent="Main"]',
      '',
      '; DSH_M2_PRE_EDIT',
      '',
    ].join('\n'))

    const harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: ['--import', tsxLoader, binScript, configPath],
        cwd: root,
        env: {
          ...process.env,
          // The same composition runs unchanged against a real Godot install
          // when these are unset; here they point at the Node-run engine shim.
          DSH_GODOT_EXECUTABLE: process.execPath,
          DSH_GODOT_PREFIX: shimPath,
          // Resolve workspace packages from TypeScript source regardless of
          // the isolated cwd, exactly like the loader-smoke src mode.
          TSX_TSCONFIG_PATH: tsconfigPath,
          // Isolated harness homes so the attachment store never touches the
          // real user home.
          DSH_HOME: join(root, '.dsh'),
          DSH_AGENTS_HOME: join(root, '.agents'),
        },
      },
      provider: 'cli-mock',
      model: 'cli-mock',
    })

    try {
      const result = await harness.run('build and run the game project, then inspect, tweak, and observe it', { sessionId: 'main' })
      // The scripted turn drove every shipped game tool plus the filesystem
      // refactor legs and the observation loop through the real seams.
      for (const toolName of ['game_build', 'game_run', 'game_read_log', 'game_query_scene', 'game_query_asset', 'read', 'edit', 'game_capture_frame', 'read_image']) {
        expect(result.events.some(event => event.type === 'tool/call' && event.data.name === toolName), `tool/call ${toolName}`).toBe(true)
      }
      const toolResults = result.events.filter(event => event.type === 'tool/result')
      expect(toolResults.some(event => JSON.stringify(event).includes('SHIM: import finished'))).toBe(true)
      expect(toolResults.some(event => JSON.stringify(event).includes('captured ') && JSON.stringify(event).includes('frame.png'))).toBe(true)
      expect(result.finalResponse).toContain('GAME_AGENT_SMOKE_OK scene=Node2D asset=scene edit=done capture=')
      expect(result.finalResponse).toContain('frame.png')

      // The refactor and capture legs really landed in the isolated world.
      const edited = await readFile(join(root, 'game-project', 'main.tscn'), 'utf8')
      expect(edited).toContain('; DSH_M2_EDIT_MARKER')
      const captured = await readFile(join(root, 'game-project', 'frame.png'))
      expect(captured.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    } finally {
      // Close (and wait out) the runtime before removing its isolated world;
      // on Windows a still-live child holds the temp directory busy.
      await harness.close().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
