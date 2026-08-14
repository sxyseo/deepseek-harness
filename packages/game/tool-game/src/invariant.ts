/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-game`.
 * @module @deepseek-ai/dsh-tool-game/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-game'

/** Cordis companion plugin name. */
export const name = 'tool-game-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the consumer registers three tools on `ctx.tools`
 * (whose registry owns their lifetime) and executes everything through the
 * game runtime registry's per-call enforced surface; it holds no independent
 * mutable relation to audit.
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
