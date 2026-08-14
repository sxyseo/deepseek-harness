import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as sleepMs } from 'node:timers/promises'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

/** The project folder the scripted turn drives (created in the smoke cwd). */
const PROJECT = 'game-project'

/** The started process id recovered from the game_run result. */
let runningProcessId: string | undefined
/** How many game_read_log retries the turn has made. */
let readAttempts = 0
/** Facts recovered from the query tools for the final answer. */
let sceneRootType = 'unknown'
let assetKind = 'other'

interface PriorTool {
  name: string
  text: string
}

/** Recover the tool name and rendered text of the last tool result, if any. */
function lastToolResult(options: GenerateOptions): PriorTool | undefined {
  const last = options.messages.at(-1)
  if (last === undefined) return undefined
  const result = last.content.find(block => block.type === 'tool-result')
  if (result === undefined) return undefined
  for (const message of [...options.messages].reverse()) {
    const call = message.content.find((block): block is {
      type: 'tool-call'
      id: CallId
      name: string
      arguments: string
    } => (
      block.type === 'tool-call' && block.id === result.toolCallId
    ))
    if (call !== undefined) {
      const text = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      return { name: call.name, text }
    }
  }
  return undefined
}

async function* toolCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  usage: { input: number; output: number },
): AsyncIterable<StreamChunk> {
  const id = CallId(callId)
  const encoded = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: encoded }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: encoded } }
  yield { type: 'usage', usage: { inputTokens: usage.input, outputTokens: usage.output } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function* finalAnswer(reply: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: reply }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
  yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Keyless game-agent adapter: one real game_build/game_run/game_read_log chain
 * (with bounded log polling) followed by the M2 refactor loop — scene query,
 * asset query, filesystem read, filesystem edit — and a final answer.
 */
class CliMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = lastToolResult(options)
    if (last === undefined) {
      yield * toolCall('game-smoke-build', 'game_build', { project: PROJECT, description: 'Build the game project.' }, { input: 11, output: 3 })
      return
    }
    if (last.name === 'game_build') {
      yield * toolCall('game-smoke-run', 'game_run', { project: PROJECT, description: 'Run the game project.' }, { input: 13, output: 5 })
      return
    }
    if (last.name === 'game_run') {
      const match = /process (game-\S+)/.exec(last.text)
      runningProcessId = match?.[1]
      readAttempts = 0
      yield * toolCall('game-smoke-log', 'game_read_log', { processId: runningProcessId ?? 'game-missing' }, { input: 12, output: 4 })
      return
    }
    if (last.name === 'game_read_log') {
      // The engine process prints its startup line asynchronously; poll the
      // log (bounded, with a short pause) until it appears, like a model
      // watching a boot log.
      const seen = last.text.includes('SHIM: running project')
      if (!seen && readAttempts < 10) {
        readAttempts++
        await sleepMs(50)
        yield * toolCall(`game-smoke-log-${readAttempts}`, 'game_read_log', { processId: runningProcessId ?? 'game-missing' }, { input: 12, output: 4 })
        return
      }
      // M2 refactor loop: inspect the scene tree next.
      yield * toolCall('game-smoke-scene', 'game_query_scene', { project: PROJECT, scenePath: 'res://main.tscn' }, { input: 12, output: 4 })
      return
    }
    if (last.name === 'game_query_scene') {
      const match = /Main \(Node2D\)/.exec(last.text)
      sceneRootType = match === null ? 'unknown' : 'Node2D'
      yield * toolCall('game-smoke-asset', 'game_query_asset', { project: PROJECT, assetPath: 'res://main.tscn' }, { input: 12, output: 4 })
      return
    }
    if (last.name === 'game_query_asset') {
      assetKind = last.text.includes('is a scene') ? 'scene' : 'other'
      // Observe the file first (fs-observation-policy), then modify it.
      yield * toolCall('game-smoke-read', 'read', { file_path: 'game-project/main.tscn' }, { input: 11, output: 3 })
      return
    }
    if (last.name === 'read') {
      yield * toolCall('game-smoke-edit', 'edit', {
        file_path: 'game-project/main.tscn',
        old_string: '; DSH_M2_PRE_EDIT',
        new_string: '; DSH_M2_EDIT_MARKER',
      }, { input: 13, output: 5 })
      return
    }
    if (last.name === 'edit') {
      yield * finalAnswer(`GAME_AGENT_SMOKE_OK scene=${sceneRootType} asset=${assetKind} edit=done ${last.text.trim()}`)
    }
  }
}

export const name = 'cli-mock-llm'
export const inject = ['llm']

/** Register the keyless `cli-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new CliMockAdapter())
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step === 2 ? { ...config, reasoningEffort: OFF } : config
  })
}
