'use strict';

/**
 * Makes bundled third-party deps (Patchright) resolvable regardless of HOW the
 * plugin was launched:
 *   - Installed from a marketplace: code lives in ${CLAUDE_PLUGIN_ROOT} (ephemeral
 *     cache) but node_modules are installed into ${CLAUDE_PLUGIN_DATA} by the
 *     SessionStart hook.
 *   - Local dev: node_modules sit next to this plugin (../node_modules).
 *
 * Requiring this module (for its side effect) BEFORE require('patchright') ensures
 * either location is searched. Pure-Node modules (config/state/governor/util) never
 * require this, so the unit tests run without Patchright installed.
 */

const path = require('path');
const Module = require('module');

const candidates = [];

if (process.env.CLAUDE_PLUGIN_DATA) {
  candidates.push(path.join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules'));
}
// node_modules bundled with / installed next to the plugin
candidates.push(path.resolve(__dirname, '..', 'node_modules'));

const existing = (process.env.NODE_PATH || '')
  .split(path.delimiter)
  .filter(Boolean);

const merged = Array.from(new Set([...existing, ...candidates]));
process.env.NODE_PATH = merged.join(path.delimiter);

// Re-init Node's module search paths so bare require() picks up NODE_PATH additions.
Module._initPaths();

module.exports = { searchPaths: candidates };
