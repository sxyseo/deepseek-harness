#!/usr/bin/env node
/**
 * Project-local Vite CLI shim for the web runtime tests: mimics the argument
 * subset the web backend drives (`build` and `preview --port N --strictPort`).
 */

const args = process.argv.slice(2)

if (args[0] === 'build') {
  console.log('WEB_SHIM: vite build')
  process.exit(Number(process.env.WEB_SHIM_BUILD_EXIT ?? 0))
}

if (args[0] === 'preview') {
  console.log(`WEB_SHIM: vite preview ${args.join(' ')}`)
  // Stay alive until the provider terminates the tree.
  setInterval(() => {}, 1000)
}
