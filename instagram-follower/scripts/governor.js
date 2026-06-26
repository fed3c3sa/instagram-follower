'use strict';

/**
 * The safety governor: hard-enforces, IN CODE (independent of the model), the
 * per-hour / per-day / combined-action caps, the working-hours window, the per-run
 * cap, and the post-cooldown half-ramp. run.js asks it before every follow; nothing
 * the model is told can lift these.
 */

const state = require('./state');
const { localMinutes, randInt } = require('./util');

/** Limits after applying the post-cooldown half-ramp (½ limits for N days). */
function effectiveLimits(config, st, now) {
  const base = config.limits;
  let factor = 1;
  if (st.lastCooldownEndedAt) {
    const days = ((now ? now.getTime() : Date.now()) - new Date(st.lastCooldownEndedAt).getTime()) / 86_400_000;
    if (days >= 0 && days < config.postCooldownRampDays) factor = 0.5;
  }
  const scale = (n) => Math.max(1, Math.floor(n * factor));
  return {
    followsPerHour: scale(base.followsPerHour),
    followsPerDay: scale(base.followsPerDay),
    combinedPerDay: scale(base.combinedPerDay),
    perRun: scale(base.perRun),
    rampActive: factor < 1,
  };
}

function withinWorkingHours(config, now) {
  const cur = localMinutes(now);
  const { startMin, endMin } = config.workingHours;
  if (startMin === endMin) return true; // 24h window
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  // Overnight window (e.g. 22:00–06:00)
  return cur >= startMin || cur < endMin;
}

/** Gate the whole run. Returns { ok, code, reason, ...detail }. */
function checkCanRun(config, st, now = new Date()) {
  if (state.isInCooldown(st, now)) {
    return {
      ok: false,
      code: 'COOLDOWN',
      reason: `In safety cooldown after "${st.cooldownReason || 'action-block'}".`,
      cooldownUntil: st.cooldownUntil,
      remainingMs: state.cooldownRemainingMs(st, now),
    };
  }
  if (!withinWorkingHours(config, now)) {
    return {
      ok: false,
      code: 'WORKING_HOURS',
      reason: `Outside the configured activity window (${fmt(config.workingHours.startMin)}–${fmt(config.workingHours.endMin)} local).`,
    };
  }
  const lim = effectiveLimits(config, st, now);
  const fToday = state.followsToday(st, now);
  const aToday = state.actionsToday(st, now);
  const fHour = state.followsLastHour(st, now);
  if (fToday >= lim.followsPerDay) {
    return { ok: false, code: 'DAILY_FOLLOW_CAP', reason: `Daily follow cap reached (${fToday}/${lim.followsPerDay}).`, limits: lim };
  }
  if (aToday >= lim.combinedPerDay) {
    return { ok: false, code: 'DAILY_ACTION_CAP', reason: `Daily combined-action cap reached (${aToday}/${lim.combinedPerDay}).`, limits: lim };
  }
  if (fHour >= lim.followsPerHour) {
    return { ok: false, code: 'HOURLY_CAP', reason: `Hourly follow cap reached (${fHour}/${lim.followsPerHour}). Try again later this hour.`, limits: lim };
  }
  return { ok: true, code: 'OK', limits: lim, followBudget: followBudgetForRun(config, st, now, lim) };
}

/** How many follows this single invocation may perform. */
function followBudgetForRun(config, st, now = new Date(), lim) {
  lim = lim || effectiveLimits(config, st, now);
  const dailyFollowRemaining = Math.max(0, lim.followsPerDay - state.followsToday(st, now));
  const dailyActionRemaining = Math.max(0, lim.combinedPerDay - state.actionsToday(st, now));
  const hourRemaining = Math.max(0, lim.followsPerHour - state.followsLastHour(st, now));
  return Math.min(lim.perRun, dailyFollowRemaining, dailyActionRemaining, hourRemaining);
}

/** Per-iteration gate inside the follow loop. */
function canFollowNow(config, st, now = new Date()) {
  return checkCanRun(config, st, now); // same predicates; cheap enough to re-check
}

// ---- pacing helpers -------------------------------------------------------

function normalDelayMs(config) {
  return randInt(config.pacing.followDelayMin, config.pacing.followDelayMax);
}
function longPauseMs(config) {
  return randInt(config.pacing.longPauseMin, config.pacing.longPauseMax);
}
function pickBurstLength(config) {
  return randInt(config.pacing.longPauseEveryMin, config.pacing.longPauseEveryMax);
}
function dwellMs(config) {
  return randInt(config.pacing.dwellMin, config.pacing.dwellMax);
}
function uiDelayMs(config) {
  return randInt(config.pacing.uiDelayMin, config.pacing.uiDelayMax);
}

function fmt(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

module.exports = {
  effectiveLimits,
  withinWorkingHours,
  checkCanRun,
  followBudgetForRun,
  canFollowNow,
  normalDelayMs,
  longPauseMs,
  pickBurstLength,
  dwellMs,
  uiDelayMs,
};
