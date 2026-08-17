import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createLlmResponder } from '../src/llm-responder.ts'

/** Records every request it receives and replays a fixed script of text deltas. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: `echo: ${options.messages.at(-1)?.content[0]?.type === 'text' ? (options.messages.at(-1)?.content[0] as { text: string }).text : ''}` }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'echo' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(): Promise<{ ctx: Context; llm: LlmRuntime; adapter: ScriptedAdapter }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['scripted'], adapter)
  return { ctx, llm: ctx.llm, adapter }
}

describe('createLlmResponder', () => {
  it('streams a real ctx.llm.stream() call built from the transcript', async () => {
    const { llm, adapter } = await setup()
    const respond = createLlmResponder(llm, transcript => ({
      provider: 'scripted',
      model: 'scripted-model',
      messages: [{
        id: 'msg-1' as never,
        role: 'user',
        content: [{ type: 'text', text: transcript }],
        source: { kind: 'user' },
      }],
    }))

    const chunks: StreamChunk[] = []
    for await (const chunk of respond('hello there', new AbortController().signal)) chunks.push(chunk)

    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'echo: hello there')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'scripted', model: 'scripted-model' })
  })

  it('propagates the caller signal into the underlying request so a real adapter can cancel on barge-in', async () => {
    const { llm, adapter } = await setup()
    const respond = createLlmResponder(llm, () => ({
      provider: 'scripted',
      model: 'scripted-model',
      messages: [],
    }))
    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    for await (const chunk of respond('hi', controller.signal)) chunks.push(chunk)

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.signal).toBe(controller.signal)
  })
})
