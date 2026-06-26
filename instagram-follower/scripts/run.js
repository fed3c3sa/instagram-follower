#!/usr/bin/env node
'use strict';

/**
 * CLI orchestrator for the Instagram commenter-follower.
 *
 * Modes:
 *   --status                 Print caps, usage, cooldown, pending count (no browser).
 *   --login                  Open Chrome and wait for one-time manual login.
 *   --urls <a,b> [--dry-run] Extract commenters; without --dry-run, follow them
 *                            slowly under the safety governor.
 *
 * Flags: --max-per-run N, --account NAME, --data-dir PATH, --account-age TIER,
 *        --follow-style, --targets, --hours-start, --hours-end, --headless.
 *
 * Only the final JSON summary goes to STDOUT (one object). All human logging goes to
 * STDERR so callers can parse stdout. Exit codes:
 *   0 ok | 2 governor stop (cooldown/hours/caps/nothing-to-do)
 *   3 login required | 10 BLOCK detected | 1 unexpected error
 */

const { parseArgs, makeLogger, normalizePostUrl, humanDuration, sleep } = require('./util');
const { loadConfig } = require('./config');
const state = require('./state');
const governor = require('./governor');

const EXIT = { OK: 0, ERROR: 1, STOP: 2, LOGIN: 3, BLOCK: 10 };

function printSummary(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function collectUrls(cli) {
  let raw = [];
  if (cli.urls) raw = raw.concat(Array.isArray(cli.urls) ? cli.urls : [cli.urls]);
  if (cli.url) raw = raw.concat(Array.isArray(cli.url) ? cli.url : [cli.url]);
  const split = raw.flatMap((s) => String(s).split(/[\s,]+/)).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const s of split) {
    const n = normalizePostUrl(s);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return { urls: out, rejected: split.filter((s) => !normalizePostUrl(s)) };
}

function usageSnapshot(config, st, now = new Date()) {
  const lim = governor.effectiveLimits(config, st, now);
  return {
    tier: config.tier,
    effectiveLimits: lim,
    followsToday: state.followsToday(st, now),
    actionsToday: state.actionsToday(st, now),
    followsLastHour: state.followsLastHour(st, now),
    followBudgetThisRun: governor.followBudgetForRun(config, st, now, lim),
    cooldown: st.cooldownUntil
      ? { until: st.cooldownUntil, reason: st.cooldownReason, remaining: humanDuration(state.cooldownRemainingMs(st, now)) }
      : null,
    targets: state.countByStatus(st),
  };
}

async function modeStatus(config, st) {
  printSummary({ status: 'status', account: config.account, dataDir: config.dataDir, usage: usageSnapshot(config, st) });
  return EXIT.OK;
}

async function modeLogin(config, st, log) {
  const { openBrowser } = require('./browser');
  const { ensureLoggedIn } = require('./login');
  const br = await openBrowser(config);
  try {
    await ensureLoggedIn(br.context, br.page, config, log);
    printSummary({ status: 'logged_in', account: config.account });
    return EXIT.OK;
  } finally {
    await br.close();
  }
}

async function modeRun(config, st, cli, log) {
  const dryRun = cli['dry-run'] === true;
  const now = new Date();

  // Cooldown is absolute — refuse everything (even dry-run) so we never touch IG.
  if (state.isInCooldown(st, now)) {
    const snap = usageSnapshot(config, st, now);
    log.warn(`In cooldown until ${st.cooldownUntil} (${snap.cooldown.remaining}). Refusing to run.`);
    printSummary({ status: 'stopped', code: 'COOLDOWN', reason: snap.cooldown, usage: snap });
    return EXIT.STOP;
  }

  const { urls, rejected } = collectUrls(cli);
  if (rejected.length) log.warn(`Ignored ${rejected.length} non-post argument(s): ${rejected.join(', ')}`);
  if (!urls.length) {
    log.error('No valid Instagram post/reel URLs provided. Use --urls "<url1>,<url2>".');
    printSummary({ status: 'stopped', code: 'NO_URLS', reason: 'No valid post/reel URLs.' });
    return EXIT.STOP;
  }

  const { openBrowser } = require('./browser');
  const { ensureLoggedIn } = require('./login');
  const { extractCommenters } = require('./extract-commenters');
  const { followOne } = require('./follow');
  const safety = require('./safety');

  const br = await openBrowser(config);
  const result = {
    status: 'ok',
    account: config.account,
    dryRun,
    urls,
    extracted: {},
    newTargets: 0,
    followed: 0,
    requested: 0,
    skipped: 0,
    failed: 0,
    visited: 0,
  };

  try {
    await ensureLoggedIn(br.context, br.page, config, log);

    // ---- Extraction phase (all URLs) ----
    for (const url of urls) {
      const { author, usernames } = await extractCommenters(br.page, url, { config, state: st, log });
      result.extracted[url] = { author, count: usernames.length };
      let added = 0;
      for (const u of usernames) {
        const existed = !!st.targets[u];
        state.upsertTarget(st, { username: u, postUrl: url, status: 'pending' });
        if (!existed) added++;
      }
      result.newTargets += added;
      state.saveState(config.dataDir, config.account, st);
    }

    if (dryRun) {
      result.status = 'dry_run';
      result.pendingTotal = state.pendingTargets(st).length;
      result.pendingPreview = state.pendingTargets(st).slice(0, 50).map((t) => t.username);
      log.info(`Dry run: ${result.newTargets} new targets, ${result.pendingTotal} total pending. No follows performed.`);
      printSummary(result);
      return EXIT.OK;
    }

    // ---- Follow phase (governed) ----
    const gate = governor.checkCanRun(config, st, new Date());
    if (!gate.ok) {
      log.warn(`Governor stop before following: ${gate.reason}`);
      result.status = 'stopped';
      result.code = gate.code;
      result.reason = gate.reason;
      result.usage = usageSnapshot(config, st);
      printSummary(result);
      return EXIT.STOP;
    }

    const budget = gate.followBudget;
    const visitCap = Math.max(config.limits.perRun * 2, 15);
    log.info(`Follow budget this run: ${budget} (visit cap ${visitCap}). Tier ${config.tier}${gate.limits.rampActive ? ' [post-cooldown half-ramp ACTIVE]' : ''}.`);

    const worklist = state.pendingTargets(st);
    let burst = 0;
    let burstTarget = governor.pickBurstLength(config);

    for (const target of worklist) {
      if (result.followed >= budget) {
        log.info('Reached follow budget for this run.');
        break;
      }
      if (result.visited >= visitCap) {
        log.info('Reached profile-visit cap for this run; leaving the rest pending.');
        break;
      }
      const can = governor.canFollowNow(config, st, new Date());
      if (!can.ok) {
        log.warn(`Stopping: ${can.reason}`);
        break;
      }

      let res;
      try {
        res = await followOne(br.page, target.username, { config, state: st, log });
      } catch (err) {
        if (err && err.code === 'BLOCK_DETECTED') {
          result.status = 'blocked';
          result.code = 'BLOCK_DETECTED';
          result.reason = err.reason;
          result.usage = usageSnapshot(config, st);
          printSummary(result);
          return EXIT.BLOCK;
        }
        // Unexpected per-target error: record and continue with a short pause.
        log.warn(`@${target.username}: ${err && err.message}`);
        state.setTargetStatus(st, target.username, 'failed', { error: String(err && err.message).slice(0, 200) });
        state.appendEvent(config.dataDir, config.account, { type: 'error', username: target.username, error: String(err && err.message).slice(0, 200) });
        state.saveState(config.dataDir, config.account, st);
        result.failed++;
        result.visited++;
        await sleep(governor.uiDelayMs(config));
        continue;
      }

      result.visited++;
      if (res.status === 'followed') {
        state.recordFollow(st, new Date());
        state.setTargetStatus(st, target.username, 'followed');
        result.followed++;
        burst++;
      } else if (res.status === 'requested') {
        state.recordFollow(st, new Date()); // a follow request still spends budget
        state.setTargetStatus(st, target.username, 'requested', { error: res.reason || null });
        result.requested++;
        burst++;
      } else if (res.status === 'skipped') {
        state.setTargetStatus(st, target.username, 'skipped', { error: res.reason || null });
        result.skipped++;
      } else {
        state.setTargetStatus(st, target.username, 'failed', { error: res.reason || null });
        result.failed++;
      }
      state.appendEvent(config.dataDir, config.account, { type: res.status, username: target.username, reason: res.reason || null });
      state.saveState(config.dataDir, config.account, st);

      const consumedBudget = res.status === 'followed' || res.status === 'requested';
      const moreToDo = result.followed < budget && result.visited < visitCap;
      if (!moreToDo) break;

      if (consumedBudget) {
        if (burst >= burstTarget) {
          const p = governor.longPauseMs(config);
          log.step(`Burst of ${burst} done — long pause ${humanDuration(p)}.`);
          await sleep(p);
          burst = 0;
          burstTarget = governor.pickBurstLength(config);
        } else {
          await sleep(governor.normalDelayMs(config));
        }
      } else {
        await sleep(governor.uiDelayMs(config)); // skipped/failed: brief pause
      }
    }

    result.usage = usageSnapshot(config, st);
    result.pendingRemaining = state.pendingTargets(st).length;
    log.info(`Done: +${result.followed} followed, ${result.requested} requested, ${result.skipped} skipped, ${result.failed} failed. ${result.pendingRemaining} still pending.`);
    printSummary(result);
    return EXIT.OK;
  } finally {
    await br.close();
  }
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const log = makeLogger('ig-follower');
  const config = loadConfig(cli);
  const st = state.loadState(config.dataDir, config.account);

  // Clear any elapsed cooldown (stamps lastCooldownEndedAt → enables half-ramp).
  if (state.clearElapsedCooldown(st, new Date())) {
    state.saveState(config.dataDir, config.account, st);
    log.info('Previous cooldown elapsed — resuming at HALF limits for a few days.');
  }

  try {
    if (cli.status) return await modeStatus(config, st);
    if (cli.login) return await modeLogin(config, st, log);
    return await modeRun(config, st, cli, log);
  } catch (err) {
    if (err && (err.code === 'LOGIN_REQUIRED')) {
      log.error(err.message);
      printSummary({ status: 'login_required', reason: err.message });
      return EXIT.LOGIN;
    }
    log.error(`Fatal: ${err && err.stack ? err.stack : err}`);
    printSummary({ status: 'error', reason: String(err && err.message || err), code: err && err.code });
    return EXIT.ERROR;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Unhandled: ${err && err.stack ? err.stack : err}\n`);
    process.exit(EXIT.ERROR);
  });
