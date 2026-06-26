'use strict';

/**
 * Small shared helpers: sleep, randomness, time, logging, arg parsing.
 * No third-party deps so this (and the modules that only use it) run in plain Node
 * without Patchright installed (used by the unit tests).
 */

const RESERVED_IG_PATHS = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'direct', 'accounts', 'about',
  'developer', 'legal', 'privacy', 'terms', 'directory', 'web', 'session',
  'emails', 'challenge', 'oauth', 'ads', 'business', 'creators', 'shop',
  'api', 'graphql', 'data', 'help', 'press', 'igtv', 'tv', 'lite',
  'your_activity', 'settings', 'archive', 'saved', 'liked', 'tagged',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));
}

/** Inclusive integer in [min, max]. */
function randInt(min, max) {
  if (max < min) [min, max] = [max, min];
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Float in [min, max). */
function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

/** Randomly true with probability p (0..1). */
function chance(p) {
  return Math.random() < p;
}

/** Pause a randomized human-ish amount, in ms. */
function sleepRange(minMs, maxMs) {
  return sleep(randInt(minMs, maxMs));
}

function nowISO(d) {
  return (d || new Date()).toISOString();
}

/** UTC day key 'YYYY-MM-DD' — used for daily counters (timezone-independent reset). */
function utcDayKey(d) {
  return (d || new Date()).toISOString().slice(0, 10);
}

/** Minutes since local midnight for a Date. */
function localMinutes(d) {
  const dt = d || new Date();
  return dt.getHours() * 60 + dt.getMinutes();
}

/** Parse 'HH:MM' to minutes since midnight; returns null if invalid. */
function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Human-readable duration from ms. */
function humanDuration(ms) {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h ? h + 'h' : '', m ? m + 'm' : '', sec ? sec + 's' : '']
    .filter(Boolean)
    .join(' ');
}

/** Logger: human lines to stderr (so stdout stays clean for the final JSON summary). */
function makeLogger(prefix) {
  const tag = prefix ? `[${prefix}] ` : '';
  const line = (level, msg) => {
    const t = new Date().toISOString().slice(11, 19);
    process.stderr.write(`${t} ${tag}${level}${msg}\n`);
  };
  return {
    info: (m) => line('', m),
    warn: (m) => line('WARN ', m),
    error: (m) => line('ERROR ', m),
    step: (m) => line('• ', m),
  };
}

/**
 * Minimal argv parser. Supports:
 *   --flag                -> true
 *   --key value           -> 'value'
 *   --key=value           -> 'value'
 *   repeated --key a --key b -> ['a','b']
 */
function parseArgs(argv) {
  const out = {};
  const add = (k, v) => {
    if (k in out) {
      out[k] = Array.isArray(out[k]) ? out[k].concat(v) : [out[k], v];
    } else {
      out[k] = v;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      add(body.slice(0, eq), body.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[body] = true;
      } else {
        add(body, next);
        i++;
      }
    }
  }
  return out;
}

/** Extract a clean instagram username from a profile href like '/john.doe/' or full URL. */
function usernameFromHref(href) {
  if (!href) return null;
  let path = href;
  try {
    if (/^https?:\/\//i.test(href)) path = new URL(href).pathname;
  } catch (_) {
    /* ignore */
  }
  const parts = path.split('?')[0].split('#')[0].split('/').filter(Boolean);
  if (parts.length !== 1) return null; // profile links are a single path segment
  const u = parts[0].toLowerCase();
  if (RESERVED_IG_PATHS.has(u)) return null;
  if (!/^[a-z0-9._]{1,30}$/.test(u)) return null;
  return u;
}

/** Normalize a post/reel URL to a canonical https form; returns null if it isn't one. */
function normalizePostUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return null;
  }
  if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const kind = m[1] === 'reels' ? 'reel' : m[1];
  return `https://www.instagram.com/${kind}/${m[2]}/`;
}

module.exports = {
  RESERVED_IG_PATHS,
  sleep,
  sleepRange,
  randInt,
  randFloat,
  chance,
  nowISO,
  utcDayKey,
  localMinutes,
  parseHHMM,
  clamp,
  humanDuration,
  makeLogger,
  parseArgs,
  usernameFromHref,
  normalizePostUrl,
};
