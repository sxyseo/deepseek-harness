#!/usr/bin/env node
/**
 * Godot CLI shim for provider tests: mimics the argument subset the Godot
 * backend drives. It is a Node script (run through the real subprocess seam),
 * so `argv[0]` is always `process.execPath` and the script lands in `argv[1]`.
 */

const args = process.argv.slice(2)

if (args.includes('--import')) {
  console.log('SHIM: import finished')
  const exportIndex = args.indexOf('--export-release')
  if (exportIndex !== -1) {
    const preset = args[exportIndex + 1]
    const output = args[exportIndex + 2]
    console.log(`SHIM: exported preset ${preset} to ${output}`)
    process.exit(Number(process.env.SHIM_EXPORT_EXIT ?? 0))
  }
  process.exit(Number(process.env.SHIM_IMPORT_EXIT ?? 0))
}

const pathIndex = args.indexOf('--path')
const project = pathIndex !== -1 ? args[pathIndex + 1] : ''
console.log(`SHIM: running project ${project}`)
// Stay alive until the provider terminates the tree.
setInterval(() => {}, 1000)
