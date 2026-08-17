#!/usr/bin/env node
/**
 * Browser CLI shim for the web runtime tests: mimics the Chromium
 * `--headless --screenshot=<path> <url>` capture invocation by writing a real
 * 1x1 PNG to the requested path.
 */

const args = process.argv.slice(2)
const screenshot = args.find(arg => arg.startsWith('--screenshot='))
if (screenshot === undefined) {
  console.error('browser-shim: no --screenshot= argument')
  process.exit(1)
}
if (process.env.WEB_SHIM_BROWSER_FAIL !== undefined) {
  console.error('browser-shim: simulated capture failure')
  process.exit(1)
}
const { writeFileSync } = await import('node:fs')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
writeFileSync(screenshot.slice('--screenshot='.length), png)
console.log(`browser-shim: captured ${String(args.at(-1))}`)
