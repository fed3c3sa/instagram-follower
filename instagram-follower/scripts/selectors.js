'use strict';

/**
 * ALL Instagram-DOM knowledge lives here so it can be re-verified/patched in one
 * place when the markup rotates. Strategy, in order of durability:
 *   1. role-based locators (getByRole) and visible TEXT  — most stable
 *   2. href-pattern extraction (/{username}/)            — stable, locale-proof
 *   3. structural heuristics (largest scrollable region) — fallback
 * We deliberately AVOID obfuscated class names (_a9ym, _aacl, …) and aria-label
 * TEXT matches (break on non-English locales).
 *
 * If extraction returns empty on a real post, re-verify here with:
 *   npx playwright codegen https://www.instagram.com/
 */

const { usernameFromHref } = require('./util');

const NOT_NOW_TEXTS = ['Not now', 'Not Now'];
const COOKIE_DECLINE_TEXTS = ['Decline optional cookies', 'Only allow essential cookies', 'Decline'];
const COOKIE_ACCEPT_TEXTS = ['Allow all cookies', 'Accept all'];

async function clickIfVisible(locator, timeout = 1500) {
  try {
    const first = locator.first();
    if (await first.isVisible({ timeout })) {
      await first.click({ timeout });
      return true;
    }
  } catch (_) {
    /* not present — fine */
  }
  return false;
}

/** Best-effort dismissal of cookie banners + "save login info" / notifications dialogs. */
async function dismissInterstitials(page, log) {
  // Cookie banner (decline preferred; fall back to accept so it doesn't block the UI).
  for (const t of COOKIE_DECLINE_TEXTS) {
    if (await clickIfVisible(page.getByRole('button', { name: t, exact: false }))) {
      if (log) log.step('Dismissed cookie banner (declined).');
      break;
    }
  }
  for (const t of COOKIE_ACCEPT_TEXTS) {
    if (await clickIfVisible(page.getByRole('button', { name: t, exact: false }))) break;
  }
  // "Save your login info?" and "Turn on Notifications" both use a "Not Now" control.
  for (let i = 0; i < 2; i++) {
    let clicked = false;
    for (const t of NOT_NOW_TEXTS) {
      if (await clickIfVisible(page.getByRole('button', { name: t, exact: true }))) {
        clicked = true;
        if (log) log.step(`Dismissed "${t}" dialog.`);
        break;
      }
      if (await clickIfVisible(page.getByText(t, { exact: true }))) {
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
  }
}

/** Heuristic login check against the CURRENT page (caller navigates first). */
async function isLoggedIn(page) {
  try {
    // A visible password field means we're on the login wall.
    if (await page.locator('input[name="password"]').first().isVisible({ timeout: 1500 })) {
      return false;
    }
  } catch (_) {
    /* ignore */
  }
  // Logged-in chrome: a Home nav link/icon or the New-post control.
  const signals = [
    page.locator('svg[aria-label="Home"]'),
    page.getByRole('link', { name: 'Home' }),
    page.locator('a[href="/"]'),
    page.locator('svg[aria-label="New post"]'),
  ];
  for (const s of signals) {
    try {
      if (await s.first().isVisible({ timeout: 1500 })) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

/** On a /p/ or /reel/ page, the author handle (to exclude from targets). */
async function getPostAuthor(page) {
  const candidates = [
    'article header a[href^="/"]',
    'header a[href^="/"]',
    'a[role="link"][href^="/"]',
  ];
  for (const sel of candidates) {
    try {
      const href = await page.locator(sel).first().getAttribute('href', { timeout: 2000 });
      const u = usernameFromHref(href);
      if (u) return u;
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

/** Make sure the comment list is on screen (open the modal / focus comments). */
async function openComments(page, log) {
  // On reels and some posts the comments are behind a comment icon / "View all comments".
  const openers = [
    page.getByText(/View all \d[\d,.]* comments/i),
    page.getByRole('link', { name: /View all .* comments/i }),
    page.locator('svg[aria-label="Comment"]'),
  ];
  for (const o of openers) {
    if (await clickIfVisible(o, 1500)) {
      if (log) log.step('Opened comments.');
      await page.waitForTimeout(800);
      break;
    }
  }
}

/**
 * Expand more comments + threaded replies. Returns how many controls it clicked.
 * Uses text/aria so it survives class churn; replies expansion only when wanted.
 */
async function expandMoreControls(page, includeReplies) {
  let clicks = 0;
  // "Load more comments" is usually an SVG button with that aria-label.
  const loadMore = [
    page.locator('svg[aria-label="Load more comments"]'),
    page.getByRole('button', { name: /Load more comments/i }),
  ];
  for (const l of loadMore) {
    if (await clickIfVisible(l, 1000)) clicks++;
  }
  if (includeReplies) {
    // "View replies (N)" / "View all N replies" — click every currently-visible one.
    const replyToggles = page.getByText(/View (all )?\d[\d,.]* repl(y|ies)/i);
    try {
      const n = await replyToggles.count();
      for (let i = 0; i < n; i++) {
        if (await clickIfVisible(replyToggles.nth(i), 600)) clicks++;
      }
    } catch (_) {
      /* ignore */
    }
  }
  return clicks;
}

/**
 * One scroll pass on the comments scroll-container (the element with its own
 * overflow), done in-page so we never hold a stale handle. Returns the new
 * scrollHeight (number) or -1 if no container found.
 */
async function scrollCommentsOnce(page) {
  return page.evaluate(() => {
    function findContainer() {
      const dialog = document.querySelector('div[role="dialog"]');
      const scope = dialog || document.querySelector('article') || document.body;
      let best = null;
      let bestScore = -1;
      const all = scope.querySelectorAll('*');
      for (const el of all) {
        const s = getComputedStyle(el);
        const oy = s.overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 60) {
          const links = el.querySelectorAll('a[href^="/"]').length;
          if (links > 2 && el.scrollHeight > bestScore) {
            best = el;
            bestScore = el.scrollHeight;
          }
        }
      }
      return best || scope;
    }
    const c = findContainer();
    if (!c) return -1;
    c.scrollTop = c.scrollHeight;
    // Also nudge the window in case comments live in the page flow (reel pages).
    window.scrollTo(0, document.body.scrollHeight);
    return c.scrollHeight || document.body.scrollHeight || 0;
  });
}

/** Collect candidate commenter usernames currently in the comments region. */
async function collectCommenterUsernames(page) {
  const hrefs = await page.evaluate(() => {
    function findContainer() {
      const dialog = document.querySelector('div[role="dialog"]');
      const scope = dialog || document.querySelector('article') || document.body;
      let best = null;
      let bestScore = -1;
      for (const el of scope.querySelectorAll('*')) {
        const s = getComputedStyle(el);
        const oy = s.overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 60) {
          const links = el.querySelectorAll('a[href^="/"]').length;
          if (links > 2 && el.scrollHeight > bestScore) {
            best = el;
            bestScore = el.scrollHeight;
          }
        }
      }
      return best || scope;
    }
    const c = findContainer();
    const out = [];
    c.querySelectorAll('a[href^="/"]').forEach((a) => {
      const h = a.getAttribute('href');
      if (h) out.push(h);
    });
    return out;
  });
  const seen = new Set();
  const usernames = [];
  for (const h of hrefs) {
    const u = usernameFromHref(h);
    if (u && !seen.has(u)) {
      seen.add(u);
      usernames.push(u);
    }
  }
  return usernames;
}

/** The Follow button in the profile header (anchored so it never hits Following/Follow Back). */
function followButton(page) {
  // Scope to header where possible to avoid suggested-account Follow buttons.
  const header = page.locator('header');
  return header.getByRole('button', { name: /^follow$/i });
}

/** Read the current follow-state of the profile header button. */
async function profileFollowState(page) {
  const header = page.locator('header');
  const checks = [
    { name: /^following$/i, state: 'following' },
    { name: /^requested$/i, state: 'requested' },
    { name: /^follow back$/i, state: 'follow_back' },
    { name: /^follow$/i, state: 'follow' },
  ];
  for (const c of checks) {
    try {
      if (await header.getByRole('button', { name: c.name }).first().isVisible({ timeout: 1200 })) {
        return c.state;
      }
    } catch (_) {
      /* try next */
    }
  }
  return 'unknown';
}

module.exports = {
  clickIfVisible,
  dismissInterstitials,
  isLoggedIn,
  getPostAuthor,
  openComments,
  expandMoreControls,
  scrollCommentsOnce,
  collectCommenterUsernames,
  followButton,
  profileFollowState,
};
