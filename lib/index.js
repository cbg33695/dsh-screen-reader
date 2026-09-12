// dsh-screen-reader — single entry point for the whole plugin.
//
// ONE host row loads this module and it installs BOTH halves, so the published
// package needs no subpath resolution and no second patch entry:
//   screen.js  — see_screen / screen_watch / screen_memory / vision_routes
//   toolbox.js — see_diff / vision_selftest / vision_storage

import { install as installScreen } from './screen.js'
import { install as installToolbox } from './toolbox.js'

export const name = 'dsh-screen-reader'

// Both halves register model tools, so `tools` is a hard dependency (Cordis's Guard
// rejects an undeclared ctx.tools). That is the ONLY one: this used to declare
// `timer` as well, for the continuous recording loop, which 0.3 removed. A needless
// hard dependency is not harmless - a profile without that service would leave the
// plugin waiting forever instead of loading.
export const inject = ['tools']

export function apply(ctx) {
  installScreen(ctx)
  installToolbox(ctx)
}
