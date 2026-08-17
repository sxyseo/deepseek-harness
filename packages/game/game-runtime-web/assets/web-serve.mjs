#!/usr/bin/env node
/**
 * Serve probe for the web game runtime backend: a dependency-free static file
 * server over one directory. Runs under plain Node (`node web-serve.mjs
 * <root> [port]`), prints exactly one `WEB_SERVE_URL <origin>` line on stdout
 * once listening (port 0 asks the OS for an ephemeral port), and stays alive
 * until terminated — the provider reads the URL, drives the browser capture,
 * then tears this tree down.
 */

import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

const [root, portArg] = process.argv.slice(2)
if (root === undefined) {
  console.error('web-serve: usage: node web-serve.mjs <root> [port]')
  process.exit(1)
}
const rootDir = resolve(root)
const port = Number(portArg ?? '0')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  // Directory traversal stays inside the served root or answers 403.
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  const filePath = normalize(join(rootDir, relative))
  if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
    response.writeHead(403).end('forbidden')
    return
  }
  const info = statSync(filePath, { throwIfNoEntry: false })
  if (info === undefined || !info.isFile()) {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(info.size),
  })
  createReadStream(filePath).pipe(response)
})

server.on('error', (error) => {
  console.error(`web-serve: ${String(error)}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  const { port: bound } = server.address()
  console.log(`WEB_SERVE_URL http://127.0.0.1:${String(bound)}`)
})
