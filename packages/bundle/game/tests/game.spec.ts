/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list that mounts the game seam over
 * dsh-base and reuses the headless one-shot runner.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-game bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const rows = (parsed as { insert?: { id?: string; name?: string; config?: Record<string, unknown> }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('game-runtime')?.name).toBe('@deepseek-ai/dsh-game-runtime')
    expect(byId.get('game-runtime-godot')?.name).toBe('@deepseek-ai/dsh-game-runtime-godot')
    expect(byId.get('tool-game')?.name).toBe('@deepseek-ai/dsh-tool-game')
    expect(byId.get('game-runtime')?.config?.['defaultEngine']).toBe('godot')
    // The one-shot driver is reused from the headless bundle, not re-implemented.
    expect(byId.get('headless-startup')?.name).toBe('@deepseek-ai/dsh-headless/startup')
    expect(byId.get('headless-runner')?.name).toBe('@deepseek-ai/dsh-headless')
  })
})
