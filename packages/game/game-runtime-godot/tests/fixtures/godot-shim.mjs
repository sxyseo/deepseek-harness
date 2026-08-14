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

const scriptIndex = args.indexOf('--script')
if (scriptIndex !== -1) {
  const probePath = args[scriptIndex + 1] ?? ''
  // Capture probe: write a real PNG, then report it (the scene-query probe is
  // handled by the branch below).
  if (probePath.endsWith('capture-frame.gd')) {
    const separator = args.indexOf('--', scriptIndex)
    const userArgs = separator === -1 ? [] : args.slice(separator + 1)
    const outputPath = userArgs[0] ?? 'frame.png'
    if (process.env.SHIM_CAPTURE_FAIL === '1') {
      console.error('CAPTURE_ERROR viewport produced no image')
      process.exit(2)
    }
    const { writeFileSync } = await import('node:fs')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    writeFileSync(outputPath, png)
    console.log(`CAPTURE_RESULT ${JSON.stringify({ imagePath: outputPath, width: 1, height: 1 })}`)
    process.exit(0)
  }
  // Scene-query probe invocation: args after `--` are the probe's user args.
  const separator = args.indexOf('--', scriptIndex)
  const userArgs = separator === -1 ? [] : args.slice(separator + 1)
  const scenePath = userArgs[0] ?? 'res://main.tscn'
  const root = JSON.parse(process.env.SHIM_SCENE_ROOT ?? JSON.stringify({
    path: 'Main',
    type: 'Node2D',
    name: 'Main',
    children: [
      { path: 'Main/Player', type: 'CharacterBody2D', name: 'Player', children: [] },
      { path: 'Main/World', type: 'Node2D', name: 'World', children: [] },
    ],
  }))
  if (process.env.SHIM_SCENE_FAIL === '1') {
    console.error('SCENE_QUERY_ERROR cannot load scene ' + scenePath)
    process.exit(2)
  }
  console.log(`SCENE_QUERY_RESULT ${JSON.stringify({ scenePath, root })}`)
  process.exit(0)
}

const pathIndex = args.indexOf('--path')
const project = pathIndex !== -1 ? args[pathIndex + 1] : ''
console.log(`SHIM: running project ${project}`)
// Stay alive until the provider terminates the tree.
setInterval(() => {}, 1000)
