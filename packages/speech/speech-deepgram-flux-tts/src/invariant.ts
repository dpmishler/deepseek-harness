/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-speech-deepgram-flux-tts`.
 * @module @deepseek-ai/dsh-speech-deepgram-flux-tts/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-speech-deepgram-flux-tts'

/** Cordis companion plugin name. */
export const name = 'speech-deepgram-flux-tts-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin registers exactly one provider on load
 * and owns no independent registry, mutable data, or event stream beyond
 * what `@deepseek-ai/dsh-speech` already checks.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
