'use strict';

/**
 * One-time MANUAL login. We never script credentials or 2FA (scripted credential
 * entry is the fastest way to get flagged, and 2FA/checkpoints must be a human
 * action on the trusted device). We open the real Chrome window, wait for the human
 * to log in by hand, then persist the session in the profile for all future runs.
 */

const selectors = require('./selectors');
const { sleep } = require('./util');

const HOME = 'https://www.instagram.com/';

async function gotoHome(page) {
  try {
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  } catch (_) {
    /* slow IG load — continue and let checks retry */
  }
  await page.waitForTimeout(1500);
}

/**
 * Ensure we're logged in. If already logged in, returns quickly. Otherwise prints
 * clear instructions and polls until the human logs in (or timeout).
 *
 * @returns {Promise<boolean>} true once logged in
 * @throws if login does not complete within config.loginWaitTimeoutMs
 */
async function ensureLoggedIn(context, page, config, log) {
  await gotoHome(page);
  await selectors.dismissInterstitials(page, log);

  if (await selectors.isLoggedIn(page)) {
    if (log) log.step('Session OK — already logged in.');
    return true;
  }

  // Not logged in — ask the human to do it in the open window.
  const banner = [
    '',
    '==================== MANUAL LOGIN REQUIRED ====================',
    'A Chrome window is open. Please, in THAT window:',
    '  1. Log in to the Instagram MARKETING account by hand.',
    '  2. Complete any 2FA / "confirm it\'s you" challenge yourself.',
    '  3. Leave the window open — this tool will detect the login and continue.',
    'Nothing is typed for you; your credentials are never stored or scripted.',
    '==============================================================',
    '',
  ].join('\n');
  process.stderr.write(banner);

  const deadline = Date.now() + config.loginWaitTimeoutMs;
  let announced = 0;
  while (Date.now() < deadline) {
    await sleep(4000);
    try {
      await selectors.dismissInterstitials(page, null);
      if (await selectors.isLoggedIn(page)) {
        if (log) log.step('Login detected. Session persisted to the Chrome profile.');
        await selectors.dismissInterstitials(page, log);
        return true;
      }
    } catch (_) {
      /* page may be mid-navigation during login; keep polling */
    }
    const waitedMin = Math.floor((config.loginWaitTimeoutMs - (deadline - Date.now())) / 60000);
    if (waitedMin > announced) {
      announced = waitedMin;
      if (log) log.info(`Still waiting for manual login… (${waitedMin}m elapsed)`);
    }
  }

  const e = new Error('Manual login was not completed in time. Re-run `--login` and finish signing in.');
  e.code = 'LOGIN_REQUIRED';
  throw e;
}

module.exports = { ensureLoggedIn, gotoHome, HOME };
