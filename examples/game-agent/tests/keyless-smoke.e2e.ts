import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('./fixtures/game-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cli.cordis.yml', import.meta.url))
const shimPath = fileURLToPath(new URL('./fixtures/godot-shim.mjs', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const decompress = promisify(zstdDecompress)

describe('game-agent keyless smoke', () => {
  it('boots the real Loader tree and runs the build/run/query/refactor/observe round trip', async () => {
    let persistedHeader: Record<string, unknown> | undefined
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'game-agent',
      tempDirPrefix: 'game-agent-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'build and run the game project, then inspect and tweak its main scene'],
      tsconfigPath,
      // Point the Godot backend at a Node-run engine shim: the same composition
      // runs unchanged against a real Godot install when these are unset.
      env: { DSH_GODOT_EXECUTABLE: process.execPath, DSH_GODOT_PREFIX: shimPath },
      prepare: async (cwd) => {
        // The scripted turn targets this project folder; the Godot backend
        // validates it exists before spawning, and the query/refactor legs
        // read and edit the scene file below.
        await mkdir(join(cwd, 'game-project'), { recursive: true })
        await writeFile(join(cwd, 'game-project', 'main.tscn'), [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[node name="Main" type="Node2D"]',
          '[node name="Player" type="CharacterBody2D" parent="Main"]',
          '',
          '; DSH_M2_PRE_EDIT',
          '',
        ].join('\n'))
      },
      inspect: async (cwd) => {
        // The refactor leg really edited the scene file through tool-fs, and
        // the capture leg really wrote a PNG through the engine shim.
        const edited = await readFile(join(cwd, 'game-project', 'main.tscn'), 'utf8')
        expect(edited).toContain('; DSH_M2_EDIT_MARKER')
        expect(edited).not.toContain('DSH_M2_PRE_EDIT')
        const captured = await readFile(join(cwd, 'game-project', 'frame.png'))
        expect(captured.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
        const files = await readdir(cwd, { recursive: true })
        const relativePath = files.find(file => file.endsWith('.jsonl.zstd'))
        if (relativePath === undefined) return
        const compressed = await readFile(join(cwd, relativePath))
        expect(compressed.subarray(0, 4).toString('hex')).toBe('28b52ffd')
        persistedHeader = JSON.parse((await decompress(compressed)).toString()) as Record<string, unknown>
      },
    })
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    const result = lines.at(-1)
    expect(stderr).toBe('')
    // The scripted turn drives every shipped game tool plus the filesystem
    // refactor legs and the observation loop through the real seams.
    for (const toolName of ['game_build', 'game_run', 'game_read_log', 'game_query_scene', 'game_query_asset', 'read', 'edit', 'game_capture_frame', 'read_image']) {
      expect(events.some(event => event.type === 'tool/call' && event.data.name === toolName), `tool/call ${toolName}`).toBe(true)
    }
    const toolResults = events.filter(event => event.type === 'tool/result')
    expect(toolResults.some(event => JSON.stringify(event).includes('SHIM: import finished'))).toBe(true)
    expect(toolResults.some(event => JSON.stringify(event).includes('SHIM: running project'))).toBe(true)
    expect(toolResults.some(event => JSON.stringify(event).includes('Main (Node2D)'))).toBe(true)
    expect(toolResults.some(event => JSON.stringify(event).includes('is a scene'))).toBe(true)
    expect(toolResults.some(event => JSON.stringify(event).includes('captured ') && JSON.stringify(event).includes('frame.png') && JSON.stringify(event).includes('(1x1)'))).toBe(true)
    expect(result).toMatchObject({ type: 'result' })
    const output = String(result?.['output'])
    expect(output).toContain('GAME_AGENT_SMOKE_OK scene=Node2D asset=scene edit=done capture=')
    expect(output).toContain('frame.png')
    const usage = result?.['usage'] as { reasoningTokens?: number } | undefined
    expect(usage?.reasoningTokens).toBe(1)
    expect(persistedHeader).toMatchObject({ type: 'session' })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
