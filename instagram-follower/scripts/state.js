'use strict';

/**
 * Resume-safe persistent state, per account, under <dataDir>/state/.
 *   - <account>.json       : the live state document (atomic write)
 *   - <account>.events.jsonl : append-only audit log of every action
 *
 * The status map is keyed by lowercased username (with numeric pk when known) so a
 * crash, Ctrl-C, or cooldown resumes exactly where it stopped and NEVER re-follows
 * anyone. Daily/hourly counters and the cooldown live here too.
 */

const fs = require('fs');
const path = require('path');
const { utcDayKey, nowISO } = require('./util');

const STATE_VERSION = 1;

function stateDir(dataDir) {
  return path.join(dataDir, 'state');
}
function statePath(dataDir, account) {
  return path.join(stateDir(dataDir), `${account}.json`);
}
function eventsPath(dataDir, account) {
  return path.join(stateDir(dataDir), `${account}.events.jsonl`);
}

function emptyState(account) {
  return {
    version: STATE_VERSION,
    account,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    cooldownUntil: null,
    cooldownReason: null,
    lastCooldownEndedAt: null, // drives the post-cooldown half-ramp
    counters: { byDay: {} }, // { 'YYYY-MM-DD': { follows, actions } }
    recentFollowTimestamps: [], // ISO strings, pruned to the last hour
    targets: {}, // username -> { username, pk, status, postUrl, firstSeen, updatedAt, error }
  };
}

function loadState(dataDir, account) {
  const p = statePath(dataDir, account);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const s = JSON.parse(raw);
    // Forward-compatible defaults for older files.
    s.counters = s.counters || { byDay: {} };
    s.counters.byDay = s.counters.byDay || {};
    s.recentFollowTimestamps = s.recentFollowTimestamps || [];
    s.targets = s.targets || {};
    if (!('lastCooldownEndedAt' in s)) s.lastCooldownEndedAt = null;
    return s;
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState(account);
    throw err;
  }
}

function saveState(dataDir, account, state) {
  const dir = stateDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  state.updatedAt = nowISO();
  const p = statePath(dataDir, account);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p); // atomic on the same filesystem
}

function appendEvent(dataDir, account, event) {
  const dir = stateDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const rec = Object.assign({ ts: nowISO() }, event);
  fs.appendFileSync(eventsPath(dataDir, account), JSON.stringify(rec) + '\n');
}

// ---- counters -------------------------------------------------------------

function dayCounter(state, now) {
  const key = utcDayKey(now);
  if (!state.counters.byDay[key]) state.counters.byDay[key] = { follows: 0, actions: 0 };
  return state.counters.byDay[key];
}

function followsToday(state, now) {
  return dayCounter(state, now).follows;
}
function actionsToday(state, now) {
  return dayCounter(state, now).actions;
}

function pruneHourWindow(state, now) {
  const cutoff = (now ? now.getTime() : Date.now()) - 60 * 60 * 1000;
  state.recentFollowTimestamps = state.recentFollowTimestamps.filter(
    (t) => new Date(t).getTime() >= cutoff,
  );
  return state.recentFollowTimestamps;
}

function followsLastHour(state, now) {
  return pruneHourWindow(state, now).length;
}

/** Record a successful follow: bumps follows + actions counters and the hour window. */
function recordFollow(state, now) {
  const d = dayCounter(state, now);
  d.follows += 1;
  d.actions += 1;
  state.recentFollowTimestamps.push(nowISO(now));
}

/** Record a non-follow human action (filler) against the combined daily budget. */
function recordAction(state, now) {
  dayCounter(state, now).actions += 1;
}

// ---- cooldown -------------------------------------------------------------

function setCooldown(state, untilDate, reason) {
  state.cooldownUntil = untilDate.toISOString();
  state.cooldownReason = reason || 'action-block';
}

function isInCooldown(state, now) {
  if (!state.cooldownUntil) return false;
  const t = now ? now.getTime() : Date.now();
  return t < new Date(state.cooldownUntil).getTime();
}

function cooldownRemainingMs(state, now) {
  if (!state.cooldownUntil) return 0;
  const t = now ? now.getTime() : Date.now();
  return Math.max(0, new Date(state.cooldownUntil).getTime() - t);
}

/** Clear an elapsed cooldown and stamp when it ended (enables the half-ramp). */
function clearElapsedCooldown(state, now) {
  if (state.cooldownUntil && !isInCooldown(state, now)) {
    state.lastCooldownEndedAt = nowISO(now);
    state.cooldownUntil = null;
    state.cooldownReason = null;
    return true;
  }
  return false;
}

// ---- targets --------------------------------------------------------------

function upsertTarget(state, target) {
  const key = String(target.username).toLowerCase();
  const existing = state.targets[key];
  if (existing) {
    // Never downgrade a terminal status back to pending.
    if (target.pk && !existing.pk) existing.pk = target.pk;
    if (target.postUrl && !existing.postUrl) existing.postUrl = target.postUrl;
    existing.updatedAt = nowISO();
    return existing;
  }
  state.targets[key] = {
    username: key,
    pk: target.pk || null,
    status: target.status || 'pending',
    postUrl: target.postUrl || null,
    error: null,
    firstSeen: nowISO(),
    updatedAt: nowISO(),
  };
  return state.targets[key];
}

function setTargetStatus(state, username, status, extra) {
  const key = String(username).toLowerCase();
  const t = state.targets[key] || upsertTarget(state, { username: key });
  t.status = status;
  t.updatedAt = nowISO();
  if (extra && extra.error !== undefined) t.error = extra.error;
  if (extra && extra.pk) t.pk = extra.pk;
  return t;
}

function pendingTargets(state) {
  return Object.values(state.targets).filter((t) => t.status === 'pending');
}

function countByStatus(state) {
  const out = {};
  for (const t of Object.values(state.targets)) {
    out[t.status] = (out[t.status] || 0) + 1;
  }
  return out;
}

module.exports = {
  STATE_VERSION,
  statePath,
  eventsPath,
  emptyState,
  loadState,
  saveState,
  appendEvent,
  dayCounter,
  followsToday,
  actionsToday,
  pruneHourWindow,
  followsLastHour,
  recordFollow,
  recordAction,
  setCooldown,
  isInCooldown,
  cooldownRemainingMs,
  clearElapsedCooldown,
  upsertTarget,
  setTargetStatus,
  pendingTargets,
  countByStatus,
};
