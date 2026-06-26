'use strict';

/**
 * Open a post/reel and harvest the usernames of everyone who commented (and, when
 * configured, threaded repliers). DOM-based, in the same logged-in Chrome as the
 * follow step (one coherent identity). Bounded scroll loop that stops at the true
 * end of the comment list — never assumes a fixed count.
 */

const selectors = require('./selectors');
const safety = require('./safety');
const { sleepRange } = require('./util');

/**
 * @returns {Promise<{author: string|null, usernames: string[], iterations: number}>}
 */
async function extractCommenters(page, postUrl, ctx) {
  const { config, state, log } = ctx;

  if (log) log.step(`Opening ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await selectors.dismissInterstitials(page, null);
  await safety.assertNotBlocked(config, state, page, log, 'open post');

  const author = await selectors.getPostAuthor(page);
  if (log) log.step(`Post author: ${author || '(unknown)'}`);

  await selectors.openComments(page, log);

  const found = new Map(); // username -> true (insertion order preserved)
  let stable = 0;
  let iterations = 0;
  const maxIter = config.scrollMaxIterations;

  for (; iterations < maxIter; iterations++) {
    // Reveal more comments + (optionally) replies first.
    const clicked = await selectors.expandMoreControls(page, config.includeReplies);

    // Collect whatever is currently rendered.
    const batch = await selectors.collectCommenterUsernames(page);
    const before = found.size;
    for (const u of batch) {
      if (u && u !== author) found.set(u, true);
    }
    const grew = found.size > before;

    // Periodic block check (cheap) — a throttle can appear mid-scroll.
    if (iterations % 6 === 5) {
      await safety.assertNotBlocked(config, state, page, log, 'scroll comments');
    }

    // Scroll the comments container and wait a human-ish beat.
    const h = await selectors.scrollCommentsOnce(page);
    await sleepRange(config.pacing.scrollWaitMin, config.pacing.scrollWaitMax);

    if (!grew && clicked === 0) {
      stable += 1;
      if (stable >= 4) break; // four quiet passes = genuinely the end of the list
    } else {
      stable = 0;
    }
    if (h === -1 && !grew) break; // no scroll container and nothing new
  }

  // One final sweep.
  for (const u of await selectors.collectCommenterUsernames(page)) {
    if (u && u !== author) found.set(u, true);
  }

  const usernames = Array.from(found.keys());
  if (log) log.step(`Extracted ${usernames.length} unique commenters from this post (${iterations} scroll passes).`);
  return { author, usernames, iterations };
}

module.exports = { extractCommenters };
