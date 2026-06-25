// SPDX-License-Identifier: Apache-2.0
// 验证打包后的 Codex CLI 路径解析

const path = require('path')
const { existsSync } = require('fs')

// 模拟打包后的路径结构
const mockAppAsarPath = path.join(
  __dirname,
  '..',
  'dist',
  'win-unpacked',
  'resources',
  'app.asar',
  'node_modules',
  '@openai',
  'codex-win32-x64'
)

const mockPackageJsonPath = path.join(mockAppAsarPath, 'package.json')

console.log('=== Codex CLI Path Verification ===\n')
console.log('Simulating packaged app environment:')
console.log(`  Package dir (asar): ${mockAppAsarPath}`)
console.log(`  Package.json exists: ${existsSync(mockPackageJsonPath)}`)
console.log()

// 测试当前布局：bin/codex.exe
const currentLayoutExe = path.join(
  mockAppAsarPath.replace('app.asar', 'app.asar.unpacked'),
  'vendor',
  'x86_64-pc-windows-msvc',
  'bin',
  'codex.exe'
)
const currentLayoutPath = path.join(
  mockAppAsarPath.replace('app.asar', 'app.asar.unpacked'),
  'vendor',
  'x86_64-pc-windows-msvc',
  'codex-path'
)

console.log('Current layout (0.137.0+):')
console.log(`  Executable: ${currentLayoutExe}`)
console.log(`  Exists: ${existsSync(currentLayoutExe)}`)
console.log(`  PATH dir: ${currentLayoutPath}`)
console.log(`  Exists: ${existsSync(currentLayoutPath)}`)

if (existsSync(currentLayoutPath)) {
  const rgExe = path.join(currentLayoutPath, 'rg.exe')
  console.log(`  Contains rg.exe: ${existsSync(rgExe)}`)
}
console.log()

// 测试旧布局：codex/codex.exe（向后兼容）
const legacyLayoutExe = path.join(
  mockAppAsarPath.replace('app.asar', 'app.asar.unpacked'),
  'vendor',
  'x86_64-pc-windows-msvc',
  'codex',
  'codex.exe'
)
const legacyLayoutPath = path.join(
  mockAppAsarPath.replace('app.asar', 'app.asar.unpacked'),
  'vendor',
  'x86_64-pc-windows-msvc',
  'path'
)

console.log('Legacy layout (pre-0.137.0):')
console.log(`  Executable: ${legacyLayoutExe}`)
console.log(`  Exists: ${existsSync(legacyLayoutExe)}`)
console.log(`  PATH dir: ${legacyLayoutPath}`)
console.log(`  Exists: ${existsSync(legacyLayoutPath)}`)
console.log()

// 验证结论
if (existsSync(currentLayoutExe)) {
  console.log('✓ Current layout detected: Codex 0.137.0+ is packaged correctly')
  console.log(`✓ OpenCow will use: ${currentLayoutExe}`)
  if (existsSync(currentLayoutPath)) {
    console.log(`✓ Helper tools (rg.exe) will be available via PATH`)
  }
} else if (existsSync(legacyLayoutExe)) {
  console.log('✓ Legacy layout detected: Codex pre-0.137.0 is packaged correctly')
  console.log(`✓ OpenCow will use: ${legacyLayoutExe}`)
} else {
  console.log('✗ ERROR: No Codex CLI found in unpacked resources!')
  console.log('  Check asarUnpack configuration in package.json')
  process.exit(1)
}
