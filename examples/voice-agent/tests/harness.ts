/**
 * Shared boot helper for the voice-agent example's tests: mounts the real
 * `cordis.yml` through the real Loader (in-process, no subprocess) with an
 * isolated `$DSH_HOME` so `dsh-settings-file`/`dsh-credentials-local` never
 * touch a contributor's real harness home.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const CORDIS_YML = fileURLToPath(new URL('../cordis.yml', import.meta.url))

/** One booted composition and its teardown. */
export interface BootedVoiceAgent {
  readonly ctx: Context
  dispose(): Promise<void>
}

/**
 * Boot `examples/voice-agent/cordis.yml` through the real Loader.
 * @param env - environment overrides applied only for the duration of this boot
 *   (e.g. `DEEPGRAM_API_KEY`, `DEEPSEEK_API_KEY`); restored on `dispose()`.
 * @returns the live Cordis context and a disposer that unmounts the tree,
 *   removes the isolated `$DSH_HOME`, and restores the environment.
 */
export async function bootVoiceAgent(env: Record<string, string | undefined> = {}): Promise<BootedVoiceAgent> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-voice-agent-example-'))
  const previous = new Map<string, string | undefined>()
  const applied = { ...env, DSH_HOME: home }
  for (const [key, value] of Object.entries(applied)) {
    previous.set(key, process.env[key])
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(CORDIS_YML).href } })
  await ctx.loader.await()

  return {
    ctx,
    dispose: async () => {
      await ctx.fiber.dispose()
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      rmSync(home, { recursive: true, force: true })
    },
  }
}
