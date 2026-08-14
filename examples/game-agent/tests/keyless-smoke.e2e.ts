import { mkdir, readFile, readdir } from 'node:fs/promises'
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
  it('boots the real Loader tree and runs a real game_build/game_run/game_read_log round trip', async () => {
    let persistedHeader: Record<string, unknown> | undefined
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'game-agent',
      tempDirPrefix: 'game-agent-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'build and run the game project'],
      tsconfigPath,
      // Point the Godot backend at a Node-run engine shim: the same composition
      // runs unchanged against a real Godot install when these are unset.
      env: { DSH_GODOT_EXECUTABLE: process.execPath, DSH_GODOT_PREFIX: shimPath },
      prepare: async (cwd) => {
        // The scripted turn targets this project folder; the Godot backend
        // validates it exists before spawning.
        await mkdir(join(cwd, 'game-project'), { recursive: true })
      },
      inspect: async (cwd) => {
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
    // The scripted turn drives every shipped game tool through the real seam.
    for (const toolName of ['game_build', 'game_run', 'game_read_log']) {
      expect(events.some(event => event.type === 'tool/call' && event.data.name === toolName), `tool/call ${toolName}`).toBe(true)
    }
    const toolResults = events.filter(event => event.type === 'tool/result')
    expect(toolResults.some(event => JSON.stringify(event).includes('SHIM: import finished'))).toBe(true)
    expect(toolResults.some(event => JSON.stringify(event).includes('SHIM: running project'))).toBe(true)
    expect(result).toMatchObject({ type: 'result' })
    expect(String(result?.['output'])).toContain('GAME_AGENT_SMOKE_OK')
    const usage = result?.['usage'] as { reasoningTokens?: number } | undefined
    expect(usage?.reasoningTokens).toBe(1)
    expect(persistedHeader).toMatchObject({ type: 'session' })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
