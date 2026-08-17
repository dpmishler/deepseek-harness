/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-flux-tts`.
 * @module @deepseek-ai/dsh-flux-tts/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-flux-tts'

/** Cordis companion plugin name. */
export const name = 'flux-tts-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this provider contributes one registration to
 * `ctx.voice` (already enforced at that seam) and owns no independent
 * session-log stream or other mutable durable relation.
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
