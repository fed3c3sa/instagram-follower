'use strict';

/**
 * The action-block / challenge tripwire. On ANY sign of trouble we stop the whole
 * run immediately, screenshot it for the human, set a cooldown, and exit — we NEVER
 * auto-retry a blocked action or auto-solve a challenge (each retry lowers trust and
 * can escalate a temporary block to a permanent disable; a human resolves challenges
 * manually on the trusted device).
 */

const fs = require('fs');
const path = require('path');
const state = require('./state');

class BlockError extends Error {
  constructor(reason) {
    super(`Instagram block/challenge detected: ${reason}`);
    this.name = 'BlockError';
    this.code = 'BLOCK_DETECTED';
    this.reason = reason;
  }
}

// Visible-text signals of a block, throttle, or verification challenge.
const BLOCK_TEXT_PATTERNS = [
  /action blocked/i,
  /we restrict certain activity/i,
  /try again later/i,
  /please wait a few minutes/i,
  /you'?re temporarily blocked/i,
  /we detected unusual/i,
  /unusual activity/i,
  /confirm it'?s you/i,
  /help us confirm/i,
  /suspended your account/i,
  /your account has been (temporarily )?(disabled|suspended)/i,
  /enter (the )?(security|confirmation) code/i,
  /we limit how often/i,
];

// URL signals.
const BLOCK_URL_PATTERNS = [/\/challenge\//i, /\/accounts\/suspended/i, /\/accounts\/disabled/i];

/**
 * Cheap, fast check on the CURRENT page. Returns { blocked:boolean, reason:string }.
 */
async function detectBlock(page) {
  try {
    const url = page.url();
    for (const re of BLOCK_URL_PATTERNS) {
      if (re.test(url)) return { blocked: true, reason: `URL matched ${re} (${url})` };
    }
  } catch (_) {
    /* ignore */
  }
  let text = '';
  try {
    text = await page.evaluate(() => document.body ? document.body.innerText : '');
  } catch (_) {
    try {
      text = await page.content();
    } catch (_) {
      /* ignore */
    }
  }
  for (const re of BLOCK_TEXT_PATTERNS) {
    if (re.test(text)) return { blocked: true, reason: `Page text matched ${re}` };
  }
  return { blocked: false, reason: '' };
}

function screenshotsDir(dataDir) {
  return path.join(dataDir, 'screenshots');
}

/**
 * Trip the wire: screenshot, set cooldown in state, persist, and throw BlockError.
 * Caller must let the BlockError propagate (do NOT catch-and-continue).
 */
async function handleBlock(config, st, page, reason, log) {
  const now = new Date();
  const dir = screenshotsDir(config.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const shot = path.join(dir, `block-${now.toISOString().replace(/[:.]/g, '-')}.png`);
  try {
    await page.screenshot({ path: shot, fullPage: false });
  } catch (_) {
    /* screenshot is best-effort */
  }

  const until = new Date(now.getTime() + config.cooldownHoursOnBlock * 3600 * 1000);
  state.setCooldown(st, until, reason);
  state.appendEvent(config.dataDir, config.account, {
    type: 'block',
    reason,
    screenshot: shot,
    cooldownUntil: until.toISOString(),
  });
  state.saveState(config.dataDir, config.account, st);

  if (log) {
    log.error(`BLOCK DETECTED — ${reason}`);
    log.error(`Screenshot: ${shot}`);
    log.error(`Cooldown set until ${until.toISOString()} (${config.cooldownHoursOnBlock}h). Will resume at HALF limits.`);
    log.error('Do NOT retry. If it is a challenge, resolve it by hand in Instagram on your normal device.');
  }
  throw new BlockError(reason);
}

/** Run detectBlock and trip the wire if blocked. Returns false when clear. */
async function assertNotBlocked(config, st, page, log, context) {
  const r = await detectBlock(page);
  if (r.blocked) await handleBlock(config, st, page, `${context ? context + ': ' : ''}${r.reason}`, log);
  return false;
}

module.exports = { BlockError, detectBlock, handleBlock, assertNotBlocked, screenshotsDir };
