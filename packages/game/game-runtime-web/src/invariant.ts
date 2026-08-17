/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-game-runtime-web`.
 * @module @deepseek-ai/dsh-game-runtime-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-game-runtime-web'

/** Cordis companion plugin name. */
export const name = 'game-runtime-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider registers one backend into the game
 * runtime registry (which owns duplicate detection and disposal) and spawns
 * each engine process through the subprocess seam, whose handles own their
 * own lifetime; the provider holds no independent mutable relation to audit.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - registrant context carrying the invariants service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
