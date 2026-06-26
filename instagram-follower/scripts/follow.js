'use strict';

/**
 * Engage-then-follow a single user. Opens the profile, dwells like a human, clicks
 * the header Follow button (anchored /^follow$/i so it can never hit
 * Following / Follow Back / Requested), then VERIFIES the button flipped before
 * counting it. A profile that won't flip triggers a block check.
 */

const selectors = require('./selectors');
const safety = require('./safety');
const governor = require('./governor');
const { sleep, sleepRange } = require('./util');

const PROFILE_BASE = 'https://www.instagram.com/';

async function pageNotAvailable(page) {
  try {
    const txt = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return /Sorry, this page isn'?t available/i.test(txt);
  } catch (_) {
    return false;
  }
}

/** Light human filler: scroll the profile down and back up while dwelling. */
async function humanDwell(page, config) {
  try {
    await page.mouse.wheel(0, 600 + Math.floor(Math.random() * 600));
    await sleep(governor.dwellMs(config) / 2);
    await page.mouse.wheel(0, -(300 + Math.floor(Math.random() * 300)));
    await sleep(governor.dwellMs(config) / 2);
  } catch (_) {
    await sleep(governor.dwellMs(config));
  }
}

async function verifyFollowed(page, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await selectors.profileFollowState(page);
    if (s === 'following' || s === 'requested') return s;
    await sleep(700);
  }
  return null;
}

/**
 * @returns {Promise<{status:string, reason?:string, pk?:string|null}>}
 *   status ∈ followed | requested | skipped | failed
 */
async function followOne(page, username, ctx) {
  const { config, state, log } = ctx;
  const url = PROFILE_BASE + encodeURIComponent(username) + '/';

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleepRange(config.pacing.uiDelayMin, config.pacing.uiDelayMax);
  await selectors.dismissInterstitials(page, null);
  await safety.assertNotBlocked(config, state, page, log, `profile ${username}`);

  if (await pageNotAvailable(page)) {
    return { status: 'failed', reason: 'page_unavailable' };
  }

  const before = await selectors.profileFollowState(page);
  if (before === 'following') return { status: 'skipped', reason: 'already_following' };
  if (before === 'requested') return { status: 'requested', reason: 'already_requested' };
  if (before === 'unknown') return { status: 'failed', reason: 'no_follow_button' };

  if (config.followStyle === 'engage_then_follow') {
    await humanDwell(page, config);
  }

  let clicked;
  try {
    clicked = await selectors.clickFollowButton(page);
  } catch (err) {
    await safety.assertNotBlocked(config, state, page, log, `click follow ${username}`);
    return { status: 'failed', reason: 'click_failed' };
  }
  if (!clicked) {
    await safety.assertNotBlocked(config, state, page, log, `find follow ${username}`);
    return { status: 'failed', reason: 'no_follow_button' };
  }

  const flipped = await verifyFollowed(page);
  if (!flipped) {
    // No flip is a classic soft-block symptom — check before giving up.
    await safety.assertNotBlocked(config, state, page, log, `verify follow ${username}`);
    return { status: 'failed', reason: 'button_did_not_flip' };
  }

  if (log) log.step(`Followed @${username} (${flipped}).`);
  return { status: flipped === 'requested' ? 'requested' : 'followed' };
}

module.exports = { followOne, humanDwell, verifyFollowed };
