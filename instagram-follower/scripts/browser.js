'use strict';

/**
 * Patchright (CDP-leak-patched Playwright) launcher. ONE identity:
 *   - real Google Chrome via channel:'chrome' (genuine TLS/JA3)
 *   - HEADFUL (headless is a detection tell)
 *   - launchPersistentContext(userDataDir) so the human's manual login persists
 *   - viewport:null and NO custom userAgent/headers (per Patchright stealth guidance)
 *
 * A single-instance lock prevents two processes from corrupting the same profile
 * (the SingletonLock bug), and we always close the context cleanly.
 */

require('./deps'); // make Patchright resolvable from CLAUDE_PLUGIN_DATA or local node_modules

const fs = require('fs');
const path = require('path');

const PROFILE_SUBDIR = 'chrome-profile';
const LOCK_FILE = 'chrome.lock';
const LOCK_STALE_MS = 30 * 60 * 1000;

function loadPatchright() {
  try {
    return require('patchright');
  } catch (err) {
    const msg =
      'Patchright is not installed. Run, inside the plugin dir:\n' +
      '  npm install && npx patchright install chrome\n' +
      '(When installed as a plugin, the SessionStart hook does this into the plugin data dir.)';
    const e = new Error(msg);
    e.cause = err;
    e.code = 'PATCHRIGHT_MISSING';
    throw e;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours
  }
}

function acquireLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, LOCK_FILE);
  if (fs.existsSync(lockPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const fresh = Date.now() - (prev.ts || 0) < LOCK_STALE_MS;
      if (prev.pid && prev.pid !== process.pid && pidAlive(prev.pid) && fresh) {
        const e = new Error(
          `Another instance (pid ${prev.pid}) is using the Chrome profile. ` +
            'Only one run may touch the profile at a time. Wait for it to finish or close that Chrome window.',
        );
        e.code = 'PROFILE_LOCKED';
        throw e;
      }
    } catch (err) {
      if (err.code === 'PROFILE_LOCKED') throw err;
      // unreadable/corrupt lock -> treat as stale
    }
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  return lockPath;
}

function releaseLock(lockPath) {
  try {
    if (lockPath && fs.existsSync(lockPath)) {
      const prev = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (prev.pid === process.pid) fs.unlinkSync(lockPath);
    }
  } catch (_) {
    /* best effort */
  }
}

/**
 * Open the persistent browser. Returns { context, page, close }.
 * `close()` is idempotent and releases the lock.
 */
async function openBrowser(config, opts = {}) {
  const { chromium } = loadPatchright();
  const dataDir = config.dataDir;
  const userDataDir = path.join(dataDir, PROFILE_SUBDIR);
  fs.mkdirSync(userDataDir, { recursive: true });

  const lockPath = acquireLock(dataDir);

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: opts.headless ?? config.headless ?? false,
      viewport: null, // essential for stealth — keep the natural viewport
    });
  } catch (err) {
    releaseLock(lockPath);
    if (/executable doesn'?t exist|Failed to launch|spawn .*chrome/i.test(String(err && err.message))) {
      const e = new Error(
        'Could not launch Google Chrome via Patchright. Install it with:\n  npx patchright install chrome',
      );
      e.code = 'CHROME_MISSING';
      e.cause = err;
      throw e;
    }
    throw err;
  }

  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(45_000);

  const page = context.pages()[0] || (await context.newPage());

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await context.close();
    } catch (_) {
      /* ignore */
    }
    releaseLock(lockPath);
  };

  // Safety net: release lock if the process dies unexpectedly.
  const onExit = () => releaseLock(lockPath);
  process.once('exit', onExit);

  return { context, page, close };
}

module.exports = { openBrowser, PROFILE_SUBDIR };
