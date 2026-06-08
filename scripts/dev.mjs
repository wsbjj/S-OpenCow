#!/usr/bin/env node

import { spawn } from 'node:child_process'

const isWindows = process.platform === 'win32'
const command = isWindows ? process.env.ComSpec || 'cmd.exe' : 'sh'
const args = isWindows
  ? ['/d', '/s', '/c', 'electron-vite dev']
  : ['-lc', 'ulimit -n 10240 2>/dev/null || true; exec electron-vite dev']
const env = { ...process.env }

delete env.ELECTRON_RUN_AS_NODE

const child = spawn(command, args, {
  stdio: 'inherit',
  env
})

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal)
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

child.on('error', (error) => {
  console.error(`[dev] Failed to start ${command}: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1)
  }

  process.exit(code ?? 1)
})
