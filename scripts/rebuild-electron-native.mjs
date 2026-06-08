#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_VERSION = 1
const MODULES = ['better-sqlite3', 'node-pty']
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(scriptDir, '..')
const nodeModulesDir = path.join(projectDir, 'node_modules')
const stampPath = path.join(nodeModulesDir, '.cache', 'opencow', 'electron-native-rebuild.json')
const force = process.argv.includes('--force') || process.env.OPENCOW_FORCE_NATIVE_REBUILD === '1'

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readPackageVersion(packageName) {
  const packagePath = path.join(nodeModulesDir, packageName, 'package.json')
  if (!fs.existsSync(packagePath)) {
    throw new Error(`Missing ${packageName}; run pnpm install first`)
  }

  const packageJson = readJson(packagePath)
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error(`Unable to read ${packageName} version`)
  }

  return packageJson.version
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(projectDir, relativePath))
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return ''
  }

  return fs.readFileSync(filePath, 'utf8').trim()
}

async function createExpectedState() {
  const { getAbi } = await import('node-abi')
  const electronVersion = readPackageVersion('electron')
  const modules = Object.fromEntries(
    MODULES.map((moduleName) => [moduleName, readPackageVersion(moduleName)])
  )

  return {
    scriptVersion: SCRIPT_VERSION,
    platform: process.platform,
    arch: process.arch,
    electronVersion,
    electronAbi: getAbi(electronVersion, 'electron'),
    modules
  }
}

function readStamp() {
  if (!fs.existsSync(stampPath)) {
    return null
  }

  try {
    return readJson(stampPath)
  } catch {
    return null
  }
}

function statesMatch(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function nativeFilesPresent() {
  const betterSqliteReady = fileExists(
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  )

  if (!betterSqliteReady) {
    return false
  }

  if (process.platform === 'win32') {
    return (
      fileExists('node_modules/node-pty/build/Release/conpty.node') &&
      fileExists('node_modules/node-pty/build/Release/conpty_console_list.node') &&
      fileExists('node_modules/node-pty/build/Release/winpty-agent.exe')
    )
  }

  return fileExists('node_modules/node-pty/build/Release/pty.node')
}

function betterSqliteMatchesElectronAbi(expected) {
  const metaPath = path.join(nodeModulesDir, 'better-sqlite3', 'build', 'Release', '.forge-meta')
  const meta = readTextIfExists(metaPath)

  return meta === `${expected.arch}--${expected.electronAbi}`
}

function rebuildNativeModules() {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'pnpm'
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `pnpm exec electron-rebuild -f -w ${MODULES.join(',')}`]
      : ['exec', 'electron-rebuild', '-f', '-w', MODULES.join(',')]
  const result = spawnSync(command, args, {
    cwd: projectDir,
    stdio: 'inherit',
    env: process.env
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function writeStamp(state) {
  fs.mkdirSync(path.dirname(stampPath), { recursive: true })
  fs.writeFileSync(`${stampPath}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(`${stampPath}.tmp`, stampPath)
}

function explainReason(expected) {
  if (force) {
    return 'forced'
  }

  if (!nativeFilesPresent()) {
    return 'native binaries are missing'
  }

  if (!betterSqliteMatchesElectronAbi(expected)) {
    return `better-sqlite3 ABI is not Electron ${expected.electronAbi}`
  }

  if (!statesMatch(readStamp(), expected)) {
    return 'Electron/native dependency versions changed'
  }

  return ''
}

const expectedState = await createExpectedState()
const reason = explainReason(expectedState)

if (!reason) {
  console.log(
    `[native-rebuild] ${MODULES.join(', ')} already match Electron ${expectedState.electronVersion} (ABI ${expectedState.electronAbi}); skipping`
  )
  process.exit(0)
}

console.log(`[native-rebuild] Rebuilding ${MODULES.join(', ')} (${reason})...`)
rebuildNativeModules()

if (!nativeFilesPresent()) {
  throw new Error('native rebuild finished, but expected native binaries were not found')
}

if (!betterSqliteMatchesElectronAbi(expectedState)) {
  throw new Error(`better-sqlite3 did not rebuild for Electron ABI ${expectedState.electronAbi}`)
}

writeStamp(expectedState)
console.log('[native-rebuild] Native modules are ready for Electron')
