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

// --- Locale-aware text (English + Italian) -------------------------------
// Instagram localizes ALL button/aria text to the account's language. Matching
// only English silently breaks BOTH following (the button reads "Segui", not
// "Follow") and comment/reply expansion on a non-English account. Patterns are
// anchored where a partial match would be dangerous (e.g. "Segui" must not match
// "Segui già" = Following). Add more locales here as needed.
const FOLLOW_RE = /^(follow|segui)$/i;
const FOLLOWING_RE = /^(following|segui già|già segui|stai seguendo)$/i;
const REQUESTED_RE = /^(requested|richiesta inviata|richiesto|inviata)$/i;
const FOLLOW_BACK_RE = /^(follow back|segui anche tu)$/i;
const LOAD_MORE_COMMENTS_RE = /(load more comments|carica altri commenti|mostra altri commenti|altri commenti)/i;
const VIEW_REPLIES_RE = /(view (all )?[\d.,]+ repl(y|ies)|visualizza (tutte le |la |l')?[\d.,]+ rispost[ae]|mostra (tutte le )?[\d.,]+ rispost[ae])/i;
const VIEW_COMMENTS_RE = /(view all [\d.,]* ?comments|visualizza (tutti i )?[\d.,]* ?commenti|commenta)/i;

const NOT_NOW_TEXTS = ['Not now', 'Not Now', 'Non ora', 'Non adesso'];
const COOKIE_DECLINE_TEXTS = [
  'Decline optional cookies',
  'Only allow essential cookies',
  'Decline',
  'Rifiuta cookie facoltativi',
  'Consenti solo cookie essenziali',
  'Rifiuta',
];
const COOKIE_ACCEPT_TEXTS = ['Allow all cookies', 'Accept all', 'Consenti tutti i cookie', 'Accetta tutto'];

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
    page.locator('svg[aria-label="Nuovo post"]'),
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
    page.getByText(VIEW_COMMENTS_RE),
    page.getByRole('link', { name: VIEW_COMMENTS_RE }),
    page.locator('svg[aria-label="Comment"]'),
    page.locator('svg[aria-label="Commenta"]'),
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
  // "Load more comments" is usually an SVG button with that aria-label (localized).
  const loadMore = [
    page.locator('svg[aria-label="Load more comments"]'),
    page.locator('svg[aria-label="Carica altri commenti"]'),
    page.getByRole('button', { name: LOAD_MORE_COMMENTS_RE }),
  ];
  for (const l of loadMore) {
    if (await clickIfVisible(l, 1000)) clicks++;
  }
  if (includeReplies) {
    // "View N replies" / "Visualizza tutte le N risposte" — click every visible one.
    const replyToggles = page.getByText(VIEW_REPLIES_RE);
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
  return page.evaluate(async () => {
    function findContainer() {
      const dialog = document.querySelector('div[role="dialog"]');
      const scope = dialog || document.querySelector('article') || document.body;
      let best = null;
      let bestLinks = -1;
      const all = scope.querySelectorAll('*');
      for (const el of all) {
        const s = getComputedStyle(el);
        const oy = s.overflowY;
        // The comments list is the scrollable region that is also the densest in
        // /username/ profile links — score by link count, not raw height, so we
        // don't lock onto a tall-but-sparse wrapper.
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 60) {
          const links = el.querySelectorAll('a[href^="/"]').length;
          if (links > 2 && links > bestLinks) {
            best = el;
            bestLinks = links;
          }
        }
      }
      return best || scope;
    }
    const c = findContainer();
    if (!c) return -1;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Scroll incrementally in viewport-sized steps (not a single jump). Real wheel
    // movement + a dispatched scroll event is what triggers IG's IntersectionObserver
    // lazy-loader; setting scrollTop straight to the bottom often does not.
    const step = Math.max(200, Math.floor(c.clientHeight * 0.9) || 400);
    for (let i = 0; i < 6; i++) {
      const prev = c.scrollTop;
      c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + step);
      try {
        c.dispatchEvent(new Event('scroll', { bubbles: true }));
        c.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true }));
      } catch (_) {
        /* WheelEvent unsupported — scrollTop move is enough */
      }
      // Also nudge the window in case comments live in the page flow (reel pages).
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(120);
      if (c.scrollTop <= prev && c.scrollTop >= c.scrollHeight - c.clientHeight - 2) break; // truly at the bottom
    }
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
      let bestLinks = -1;
      for (const el of scope.querySelectorAll('*')) {
        const s = getComputedStyle(el);
        const oy = s.overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 60) {
          const links = el.querySelectorAll('a[href^="/"]').length;
          if (links > 2 && links > bestLinks) {
            best = el;
            bestLinks = links;
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

// The profile-header action buttons. Used IDENTICALLY in-page (querySelectorAll)
// and via Playwright (page.locator) so a button's index lines up on both sides.
const HEADER_BTN_SELECTOR = 'header button, header [role="button"]';

/**
 * Read the normalized VISIBLE label (innerText) of every header action button.
 *
 * Why innerText via evaluate, and not getByRole/getByText/filter:
 *  - getByRole({ name }) returns 0 — IG's follow buttons have an accessible NAME
 *    that doesn't equal their label (a button reading "Segui già" is invisible to it).
 *  - filter({ hasText }) matches textContent, which carries hidden/duplicate text,
 *    so an anchored ^…$ regex won't match.
 * innerText is the actual rendered label and is clean, so we read it ourselves and
 * classify in Node with anchored regexes (so "Segui"/Follow never matches
 * "Segui già"/Following or "Segui anche tu"/Follow back).
 *
 * @returns {Promise<Array<{index:number, text:string}>>}
 */
async function headerButtonLabels(page) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((b, i) => ({
      index: i,
      text: (b.innerText || '').trim().replace(/\s+/g, ' '),
    }));
  }, HEADER_BTN_SELECTOR);
}

/**
 * Read the current follow-state from the header button labels. Retries briefly because
 * the profile action row (Segui / Messaggio) can render a beat after the rest of the
 * header — without the wait a slow load looks like a missing follow button.
 */
async function profileFollowState(page) {
  const deadline = Date.now() + 6000;
  for (;;) {
    let labels = [];
    try {
      labels = await headerButtonLabels(page);
    } catch (_) {
      /* keep polling */
    }
    const has = (re) => labels.some((b) => re.test(b.text));
    if (has(FOLLOWING_RE)) return 'following';
    if (has(REQUESTED_RE)) return 'requested';
    if (has(FOLLOW_BACK_RE)) return 'follow_back';
    if (has(FOLLOW_RE)) return 'follow';
    if (Date.now() >= deadline) return 'unknown';
    await new Promise((r) => setTimeout(r, 700));
  }
}

/**
 * Click the header Follow button (the one whose label is exactly Follow/Segui, never
 * Following/Requested/Follow-back). Returns true if it found & clicked one.
 */
async function clickFollowButton(page) {
  const labels = await headerButtonLabels(page);
  const target = labels.find((b) => FOLLOW_RE.test(b.text));
  if (!target) return false;
  const loc = page.locator(HEADER_BTN_SELECTOR).nth(target.index);
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
  await loc.click({ timeout: 8000 });
  return true;
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
  clickFollowButton,
  profileFollowState,
};
