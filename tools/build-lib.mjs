// build-lib.mjs — generate lib/ from the agent-preset sources.
//
// WHY THIS FILE IS IN THE REPO
//
// lib/*.js used to be produced by a throwaway script kept outside the repo. That
// script had no assertion covering the path to the PowerShell helpers, so when the
// preset's file layout and the package's file layout diverged, the generated
// lib/screen.js shipped resolving `capture.ps1` next to itself - a file that does
// not exist in the package. 0.2.0 was published in that state: bundle installs
// fail at the first capture with
//   The argument '.../lib/capture.ps1' to the -File parameter does not exist.
//
// The runtime now resolves the helper in BOTH layouts (see resolveHelper in
// screen.js / toolbox.js), so this build step no longer has to rewrite that line.
// The assertions below exist so that if that resolver is ever removed, this build
// FAILS instead of silently publishing a broken package again.
//
// Usage:
//   node tools/build-lib.mjs [path-to-preset-plugin-dir]
// Defaults to ${DSH_HOME:-~/.dsh}/.agent-presets/visual-screen/plugin

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, '..', 'lib')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const SRC = process.argv[2] || join(dshHome, '.agent-presets', 'visual-screen', 'plugin')

let failed = false
function must(cond, msg) {
  if (!cond) {
    console.error('  x FAIL: ' + msg)
    failed = true
  } else {
    console.log('  + ' + msg)
  }
}

console.log('source: ' + SRC)
console.log('output: ' + OUT)
console.log('')

if (!existsSync(SRC)) {
  console.error('preset plugin directory not found: ' + SRC)
  console.error('pass it explicitly: node tools/build-lib.mjs <dir>')
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

function convert(file, outName, pluginName) {
  console.log('--- ' + file + ' -> lib/' + outName + ' ---')
  const srcPath = join(SRC, file)
  if (!existsSync(srcPath)) {
    console.error('  x missing source ' + srcPath)
    failed = true
    return ''
  }

  let s = readFileSync(srcPath, 'utf8')
  const original = s

  const a = s
  s = s.replace("export const name = '" + pluginName + "'", "const name = '" + pluginName + "'")
  must(s !== a, 'name export turned into a module-local const')

  const b = s
  s = s.replace(/export const inject = .*\r?\n/, '')
  must(s !== b, 'inject export removed (index.js declares it once)')

  const c = s
  s = s.replace('export function apply(ctx) {', 'export function install(ctx) {')
  must(s !== c, 'apply renamed to install')

  must(!/^export\s+(const\s+name|const\s+inject|function\s+apply)/m.test(s), 'no leftover top-level exports')
  must(s.length > original.length * 0.9, 'output length is sane (nothing was eaten)')

  // THE ASSERTION WHOSE ABSENCE BROKE 0.2.0.
  const helper = outName === 'screen.js' ? 'capture.ps1' : 'imageops.ps1'
  must(s.includes("resolveHelper('" + helper + "')"), outName + ' resolves ' + helper + ' via resolveHelper')
  must(s.includes("'../scripts/'"), outName + ' has the packaged-layout fallback (lib/ -> scripts/)')
  must(!new RegExp("fileURLToPath\\(new URL\\('" + helper.replace('.', '\\.') + "'").test(s),
    outName + ' does NOT use the single-layout form that shipped broken')

  writeFileSync(join(OUT, outName), s)
  return s
}

convert('screen.js', 'screen.js', 'see-screen')
convert('toolbox.js', 'toolbox.js', 'vision-toolbox')

const index = `// dsh-screen-reader — single entry point for the whole plugin.
//
// ONE host row loads this module and it installs BOTH halves, so the published
// package needs no subpath resolution and no second patch entry:
//   screen.js  — see_screen / screen_watch / screen_memory / vision_routes
//   toolbox.js — see_diff / vision_selftest / vision_storage

import { install as installScreen } from './screen.js'
import { install as installToolbox } from './toolbox.js'

export const name = 'dsh-screen-reader'

// Both halves register model tools, so \`tools\` is a hard dependency (Cordis's
// Guard rejects an undeclared ctx.tools). \`timer\` provides ctx.interval, which
// the continuous recording loop needs.
export const inject = ['tools', 'timer']

export function apply(ctx) {
  installScreen(ctx)
  installToolbox(ctx)
}
`
writeFileSync(join(OUT, 'index.js'), index)
console.log('  + lib/index.js written')

// Package-wide structural assertions.
const all = ['index.js', 'screen.js', 'toolbox.js']
  .map((f) => readFileSync(join(OUT, f), 'utf8'))
  .join('\n')
must((all.match(/export const name =/g) || []).length === 1, 'exactly one export const name in the package')
must((all.match(/export const inject =/g) || []).length === 1, 'exactly one export const inject in the package')
must((all.match(/export function apply\(/g) || []).length === 1, 'exactly one export function apply in the package')

// The .ps1 helpers must exist where the packaged layout expects them.
must(existsSync(join(OUT, '..', 'scripts', 'capture.ps1')), 'scripts/capture.ps1 exists')
must(existsSync(join(OUT, '..', 'scripts', 'imageops.ps1')), 'scripts/imageops.ps1 exists')

console.log('')
if (failed) {
  console.error('BUILD FAILED - lib/ was NOT updated correctly')
  process.exit(1)
}
console.log('OK - lib/ regenerated and all assertions passed')
