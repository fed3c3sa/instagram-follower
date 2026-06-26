'use strict';

/**
 * Resolves the effective configuration (limits, pacing, paths) from, in order of
 * precedence: CLI flags > plugin userConfig (env CLAUDE_PLUGIN_OPTION_* or
 * ${user_config.*} passed as flags) > conservative built-in defaults.
 *
 * EVERY rate number except the 7,500 standing-follow cap is unofficial community/
 * vendor consensus and is treated as a CEILING to stay UNDER, not a target. The
 * defaults below are the "extra-safe" profile the user chose, and per-tier HARD
 * CAPS clamp anything an override (or the model) tries to push higher.
 */

const path = require('path');
const { parseHHMM, clamp } = require('./util');

// Per-tier shipped defaults (extra-safe profile).
// ⚠️ NOTE: under_6_months has had ALL rate caps REMOVED at the account owner's
// explicit, repeated request ("remove caps, proceed until I tell you"). The values
// below are effectively unlimited — there is no hourly/daily/per-run ceiling, so the
// only pacing left is the 10–40s delay between follows. This abandons the anti-block
// design entirely and carries near-certain action-block / permanent-ban risk on a
// young account. The block tripwire (safety.js) is intentionally still active.
// Restore safety with 4 / 25 / 40 / 10 (defaults) and 5 / 30 / 40 / 12 (hard caps).
const UNCAPPED = { followsPerHour: 1000000, followsPerDay: 1000000, combinedPerDay: 1000000, perRun: 1000000 };
const TIER_DEFAULTS = {
  aged: { followsPerHour: 6, followsPerDay: 40, combinedPerDay: 60, perRun: 15 },
  under_6_months: { ...UNCAPPED },
  new: { followsPerHour: 2, followsPerDay: 12, combinedPerDay: 20, perRun: 6 },
};

// Absolute ceilings per tier. The governor never exceeds these no matter what an
// override asks for. (7,500 = Meta-official STANDING follow cap, enforced separately.)
// under_6_months ceilings removed to match the owner-requested uncapped profile above.
const TIER_HARD_CAPS = {
  aged: { followsPerHour: 8, followsPerDay: 60, combinedPerDay: 80, perRun: 20 },
  under_6_months: { ...UNCAPPED },
  new: { followsPerHour: 3, followsPerDay: 15, combinedPerDay: 25, perRun: 8 },
};

const STANDING_FOLLOW_CAP = 7500; // Meta-official concurrent (not lifetime) cap.

// Pacing (ms). Long, randomized — velocity matters more than daily totals.
const PACING = {
  followDelayMin: 10_000,
  followDelayMax: 40_000,
  uiDelayMin: 3_000,
  uiDelayMax: 8_000,
  longPauseMin: 120_000,
  longPauseMax: 300_000,
  longPauseEveryMin: 4, // after a burst of 4..7 follows, take a long pause
  longPauseEveryMax: 7,
  dwellMin: 3_000, // engage-then-follow: dwell on the profile before clicking
  dwellMax: 9_000,
  scrollWaitMin: 1_400, // between comment-dialog scroll passes (give lazy-load time)
  scrollWaitMax: 2_600,
};

const SCROLL_MAX_ITERATIONS = 40;
const COOLDOWN_HOURS_ON_BLOCK = 48; // within the 24–72h range
const POST_COOLDOWN_RAMP_DAYS = 3; // run at HALF limits for N days after a block clears
const LOGIN_WAIT_TIMEOUT_MS = 6 * 60 * 1000; // how long manual login may take

function readUserConfig(key) {
  // userConfig values are exported to subprocesses as CLAUDE_PLUGIN_OPTION_<KEY>.
  const env = process.env['CLAUDE_PLUGIN_OPTION_' + key.toUpperCase()];
  if (env !== undefined && env !== '') return env;
  return undefined;
}

function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normalizeTier(raw) {
  const t = String(raw || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (t === 'aged' || t === '6_months' || t === 'established') return 'aged';
  if (t === 'new' || t === 'brand_new') return 'new';
  return 'under_6_months';
}

function resolveDataDir(cli) {
  const explicit = pick(cli['data-dir'], readUserConfig('profile_dir'), process.env.CLAUDE_PLUGIN_DATA);
  if (explicit) return path.resolve(String(explicit));
  // Local-dev fallback: a gitignored .data folder next to the plugin.
  return path.resolve(__dirname, '..', '.data');
}

/**
 * @param {object} cli parsed CLI args (from util.parseArgs)
 */
function loadConfig(cli = {}) {
  const tier = normalizeTier(pick(cli['account-age'], readUserConfig('account_age'), 'under_6_months'));
  const defaults = TIER_DEFAULTS[tier];
  const hard = TIER_HARD_CAPS[tier];

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // Limits: default, optionally overridden, always clamped to the tier hard cap.
  const followsPerDay = clamp(
    pick(toNum(cli['max-per-day']), toNum(readUserConfig('max_follows_per_day')), defaults.followsPerDay),
    1,
    hard.followsPerDay,
  );
  const followsPerHour = clamp(
    pick(toNum(cli['max-per-hour']), defaults.followsPerHour),
    1,
    hard.followsPerHour,
  );
  const combinedPerDay = clamp(defaults.combinedPerDay, 1, hard.combinedPerDay);
  const perRun = clamp(
    pick(toNum(cli['max-per-run']), toNum(readUserConfig('max_per_run')), defaults.perRun),
    1,
    hard.perRun,
  );

  const whStart = parseHHMM(pick(cli['hours-start'], readUserConfig('working_hours_start'), '09:00')) ?? parseHHMM('09:00');
  const whEnd = parseHHMM(pick(cli['hours-end'], readUserConfig('working_hours_end'), '22:30')) ?? parseHHMM('22:30');

  const followStyleRaw = String(pick(cli['follow-style'], readUserConfig('follow_style'), 'engage_then_follow')).toLowerCase();
  const followStyle = followStyleRaw.includes('only') ? 'follow_only' : 'engage_then_follow';

  const targetsRaw = String(pick(cli['targets'], readUserConfig('targets'), 'commenters_and_replies')).toLowerCase();
  const includeReplies = !targetsRaw.includes('only');

  return {
    tier,
    account: String(pick(cli['account'], 'default')),
    dataDir: resolveDataDir(cli),
    limits: {
      followsPerHour,
      followsPerDay,
      combinedPerDay,
      perRun,
      standingFollowCap: STANDING_FOLLOW_CAP,
      hardCaps: hard,
    },
    workingHours: { startMin: whStart, endMin: whEnd },
    pacing: PACING,
    scrollMaxIterations: SCROLL_MAX_ITERATIONS,
    cooldownHoursOnBlock: COOLDOWN_HOURS_ON_BLOCK,
    postCooldownRampDays: POST_COOLDOWN_RAMP_DAYS,
    loginWaitTimeoutMs: LOGIN_WAIT_TIMEOUT_MS,
    followStyle,
    includeReplies,
    headless: cli['headless'] === true || cli['headless'] === 'true',
  };
}

module.exports = {
  loadConfig,
  TIER_DEFAULTS,
  TIER_HARD_CAPS,
  STANDING_FOLLOW_CAP,
  PACING,
};
