#!/usr/bin/env node
'use strict';

/**
 * Unit tests for the pure logic (util, config, state, governor). No browser, no
 * Patchright — safe to run anywhere with `npm test`. These guard the safety-critical
 * parts: caps, cooldown, working hours, resume-safety.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const util = require('./util');
const { loadConfig } = require('./config');
const state = require('./state');
const governor = require('./governor');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ✗ ${name}\n    ${err && err.message}\n`);
  }
}

// local Date at a given hour:min today
function at(hour, min = 0) {
  const d = new Date();
  d.setHours(hour, min, 0, 0);
  return d;
}

// ---- util ----------------------------------------------------------------
test('normalizePostUrl handles /p/, /reel/, bare, query', () => {
  assert.strictEqual(util.normalizePostUrl('https://www.instagram.com/p/ABC123/'), 'https://www.instagram.com/p/ABC123/');
  assert.strictEqual(util.normalizePostUrl('instagram.com/reel/Xy_9/?igsh=1'), 'https://www.instagram.com/reel/Xy_9/');
  assert.strictEqual(util.normalizePostUrl('https://instagram.com/reels/ZZ/'), 'https://www.instagram.com/reel/ZZ/');
  assert.strictEqual(util.normalizePostUrl('https://example.com/p/ABC/'), null);
  assert.strictEqual(util.normalizePostUrl('https://www.instagram.com/someuser/'), null);
});

test('usernameFromHref extracts valid handles, rejects reserved/multi-segment', () => {
  assert.strictEqual(util.usernameFromHref('/john.doe/'), 'john.doe');
  assert.strictEqual(util.usernameFromHref('/John_Doe'), 'john_doe');
  assert.strictEqual(util.usernameFromHref('/p/ABC/'), null); // reserved + multi-seg
  assert.strictEqual(util.usernameFromHref('/explore/'), null);
  assert.strictEqual(util.usernameFromHref('/a/b/'), null);
});

test('parseArgs supports flags, =, repeats', () => {
  const a = util.parseArgs(['--login', '--max-per-run', '5', '--urls=x', '--urls', 'y']);
  assert.strictEqual(a.login, true);
  assert.strictEqual(a['max-per-run'], '5');
  assert.deepStrictEqual(a.urls, ['x', 'y']);
});

test('parseHHMM', () => {
  assert.strictEqual(util.parseHHMM('09:00'), 540);
  assert.strictEqual(util.parseHHMM('22:30'), 1350);
  assert.strictEqual(util.parseHHMM('nope'), null);
});

// ---- config --------------------------------------------------------------
test('loadConfig clamps overrides to tier hard caps', () => {
  // 'new' tier still has real ceilings, so clamping behavior is exercised here.
  const c = loadConfig({ 'account-age': 'new', 'max-per-run': '999', 'max-per-day': '999', 'data-dir': os.tmpdir() });
  assert.strictEqual(c.limits.perRun, 8, 'perRun clamped to tier hard cap');
  assert.strictEqual(c.limits.followsPerDay, 15, 'followsPerDay clamped to tier hard cap');
  assert.strictEqual(c.tier, 'new');
  // under_6_months has been intentionally uncapped at the owner's request.
  const u = loadConfig({ 'account-age': 'under_6_months', 'data-dir': os.tmpdir() });
  assert.ok(u.limits.followsPerHour >= 1000000, 'under_6_months is uncapped');
});

test('loadConfig tier defaults differ', () => {
  const aged = loadConfig({ 'account-age': 'aged', 'data-dir': os.tmpdir() });
  const fresh = loadConfig({ 'account-age': 'new', 'data-dir': os.tmpdir() });
  assert.ok(aged.limits.followsPerDay > fresh.limits.followsPerDay);
  assert.strictEqual(fresh.limits.followsPerDay, 12);
});

// ---- state ---------------------------------------------------------------
test('state counters, hour window, save/load roundtrip, resume-safety', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igf-'));
  const acct = 'default';
  let st = state.loadState(dir, acct);
  const now = at(12, 0);

  state.recordFollow(st, now);
  state.recordFollow(st, now);
  assert.strictEqual(state.followsToday(st, now), 2);
  assert.strictEqual(state.actionsToday(st, now), 2);
  assert.strictEqual(state.followsLastHour(st, now), 2);

  // a follow 2h ago should be pruned from the hour window
  st.recentFollowTimestamps.push(new Date(now.getTime() - 2 * 3600 * 1000).toISOString());
  assert.strictEqual(state.followsLastHour(st, now), 2);

  state.upsertTarget(st, { username: 'Alice', postUrl: 'u', status: 'pending' });
  state.upsertTarget(st, { username: 'alice', postUrl: 'u', status: 'pending' }); // dedupe by lowercase
  assert.strictEqual(state.pendingTargets(st).length, 1);
  state.setTargetStatus(st, 'alice', 'followed');
  assert.strictEqual(state.pendingTargets(st).length, 0);

  state.saveState(dir, acct, st);
  const reloaded = state.loadState(dir, acct);
  assert.strictEqual(state.followsToday(reloaded, now), 2);
  assert.strictEqual(reloaded.targets['alice'].status, 'followed');
  // resume: followed target is never pending again
  assert.strictEqual(state.pendingTargets(reloaded).length, 0);
});

test('state cooldown set / detect / clear + ramp stamp', () => {
  const st = state.emptyState('default');
  const now = at(12, 0);
  state.setCooldown(st, new Date(now.getTime() + 3600 * 1000), 'please wait');
  assert.strictEqual(state.isInCooldown(st, now), true);
  // after it elapses
  const later = new Date(now.getTime() + 2 * 3600 * 1000);
  assert.strictEqual(state.isInCooldown(st, later), false);
  assert.strictEqual(state.clearElapsedCooldown(st, later), true);
  assert.ok(st.lastCooldownEndedAt, 'ramp stamp set');
  assert.strictEqual(st.cooldownUntil, null);
});

// ---- governor ------------------------------------------------------------
test('governor blocks during cooldown', () => {
  const c = loadConfig({ 'data-dir': os.tmpdir() });
  const st = state.emptyState('default');
  const now = at(12, 0);
  state.setCooldown(st, new Date(now.getTime() + 3600 * 1000), 'block');
  const r = governor.checkCanRun(c, st, now);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'COOLDOWN');
});

test('governor enforces working hours window', () => {
  const c = loadConfig({ 'hours-start': '09:00', 'hours-end': '22:30', 'data-dir': os.tmpdir() });
  assert.strictEqual(governor.withinWorkingHours(c, at(10, 0)), true);
  assert.strictEqual(governor.withinWorkingHours(c, at(23, 0)), false);
  assert.strictEqual(governor.withinWorkingHours(c, at(7, 0)), false);
});

test('governor overnight window wraps correctly', () => {
  const c = loadConfig({ 'hours-start': '22:00', 'hours-end': '06:00', 'data-dir': os.tmpdir() });
  assert.strictEqual(governor.withinWorkingHours(c, at(23, 0)), true);
  assert.strictEqual(governor.withinWorkingHours(c, at(3, 0)), true);
  assert.strictEqual(governor.withinWorkingHours(c, at(12, 0)), false);
});

test('governor caps: daily follow cap + budget', () => {
  const c = loadConfig({ 'account-age': 'under_6_months', 'data-dir': os.tmpdir() });
  const st = state.emptyState('default');
  const now = at(12, 0);
  // exhaust the daily follow cap (30 hard cap, default 25)
  for (let i = 0; i < c.limits.followsPerDay; i++) state.recordFollow(st, now);
  const r = governor.checkCanRun(c, st, now);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'DAILY_FOLLOW_CAP');
});

test('governor hourly cap independent of daily', () => {
  const c = loadConfig({ 'account-age': 'aged', 'data-dir': os.tmpdir() });
  const st = state.emptyState('default');
  const now = at(12, 0);
  for (let i = 0; i < c.limits.followsPerHour; i++) state.recordFollow(st, now);
  const r = governor.checkCanRun(c, st, now);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'HOURLY_CAP');
});

test('governor followBudgetForRun never exceeds perRun and respects remaining', () => {
  const c = loadConfig({ 'account-age': 'aged', 'data-dir': os.tmpdir() });
  const st = state.emptyState('default');
  const now = at(12, 0);
  const fresh = governor.followBudgetForRun(c, st, now);
  assert.ok(fresh <= c.limits.perRun);
  // hourly cap is the binding constraint for aged: 6/hr < perRun 15
  assert.strictEqual(fresh, Math.min(c.limits.perRun, c.limits.followsPerHour, c.limits.followsPerDay, c.limits.combinedPerDay));
});

test('governor post-cooldown half-ramp halves effective limits', () => {
  const c = loadConfig({ 'account-age': 'under_6_months', 'data-dir': os.tmpdir() });
  const st = state.emptyState('default');
  const now = at(12, 0);
  st.lastCooldownEndedAt = new Date(now.getTime() - 24 * 3600 * 1000).toISOString(); // 1 day ago
  const lim = governor.effectiveLimits(c, st, now);
  assert.strictEqual(lim.rampActive, true);
  assert.ok(lim.followsPerDay < c.limits.followsPerDay);
  assert.strictEqual(lim.followsPerDay, Math.max(1, Math.floor(c.limits.followsPerDay * 0.5)));
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
