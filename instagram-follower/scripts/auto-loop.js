'use strict';

/**
 * Autonomous driver: repeatedly runs `run.js --follow-pending` to work through the
 * whole pending queue over days, WITHOUT a human re-triggering each batch.
 *
 * It only ever halts for reasons where continuing would be wrong or unsafe:
 *   - a block/challenge (BLOCK_DETECTED) or an active cooldown  → stop, must rest
 *   - login required                                            → stop, manual login
 *   - the pending queue is empty                                → done
 *   - repeated unexpected errors                                → stop, needs a look
 * Everything else (hourly cap, daily cap, outside working hours) is a NORMAL pause:
 * it sleeps the right amount and continues on its own.
 *
 * The per-run safety governor in run.js is still fully in force — this wrapper never
 * raises a limit; it just decides how long to wait between governed runs.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const RUN = path.join(__dirname, 'run.js');
const DATA_DIR = path.resolve(__dirname, '..', '.data');
const LOG = path.join(DATA_DIR, 'auto-loop.log');
const RESUME_HOUR = 9; // local hour to resume after a daily-cap / night pause (inside 09:00–22:30)
const RESUME_MIN = 15;

function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG, line);
  } catch (_) {
    /* ignore */
  }
  process.stdout.write(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutes = (m) => m * 60 * 1000;
const jitter = (baseMs, fracPlusMinus = 0.1) =>
  Math.round(baseMs * (1 + (Math.random() * 2 - 1) * fracPlusMinus));

/** ms until the next RESUME_HOUR:RESUME_MIN local time (today if still ahead, else tomorrow). */
function msUntilNextResume() {
  const now = new Date();
  const t = new Date(now);
  t.setHours(RESUME_HOUR, RESUME_MIN, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return Math.max(minutes(5), t.getTime() - now.getTime());
}

/** Run one governed batch; resolve with the parsed result JSON (from stdout). */
function runOnce() {
  return new Promise((resolve) => {
    const child = spawn('node', [RUN, '--follow-pending'], {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      // Mirror the runner's step logs into our log so progress is visible in one place.
      process.stderr.write(d);
    });
    child.on('close', () => {
      let parsed = null;
      // The summary JSON is the last {...} block on stdout.
      const start = out.lastIndexOf('\n{');
      const slice = start >= 0 ? out.slice(start + 1) : out;
      try {
        parsed = JSON.parse(slice.trim());
      } catch (_) {
        try {
          parsed = JSON.parse(out.trim());
        } catch (_) {
          parsed = { status: 'unparseable', raw: out.slice(-400) };
        }
      }
      resolve(parsed);
    });
    child.on('error', (err) => resolve({ status: 'spawn_error', reason: String(err && err.message) }));
  });
}

let totalFollowed = 0;
let totalRequested = 0;

async function main() {
  log('=== auto-loop started — will run --follow-pending continuously, stopping only on block/cooldown/login/empty-queue ===');
  let consecutiveErrors = 0;

  for (;;) {
    const res = await runOnce();
    const code = res.code || '';
    const status = res.status || '';

    if (typeof res.followed === 'number') totalFollowed += res.followed;
    if (typeof res.requested === 'number') totalRequested += res.requested;

    // ---- Hard stops (safety / nothing-more-to-do) ----
    if (status === 'blocked' || code === 'BLOCK_DETECTED') {
      log(`!! BLOCK/CHALLENGE detected (${res.reason || ''}). STOPPING. Do NOT restart — let the cooldown elapse and resolve any challenge by hand. Cumulative this loop: ${totalFollowed} followed, ${totalRequested} requested.`);
      process.exit(10);
    }
    if (code === 'COOLDOWN') {
      log(`!! In safety cooldown (${JSON.stringify(res.reason)}). STOPPING — let it rest. Cumulative: ${totalFollowed} followed.`);
      process.exit(10);
    }
    if (status === 'login_required') {
      log('!! Login required. STOPPING — run `node scripts/run.js --login` and sign in by hand, then restart the loop.');
      process.exit(3);
    }
    if (status === 'ok' && res.pendingRemaining === 0) {
      log(`✅ DONE — pending queue empty. Cumulative this loop: ${totalFollowed} followed, ${totalRequested} requested.`);
      process.exit(0);
    }

    // ---- Normal pauses (decide how long, then keep going) ----
    if (status === 'ok' || status === 'stopped') {
      consecutiveErrors = 0;
      if (status === 'ok') {
        log(`batch ok: +${res.followed} followed, ${res.requested} requested, ${res.skipped} skipped, ${res.failed} failed (${res.pendingRemaining} pending). Cumulative: ${totalFollowed}.`);
      } else {
        log(`batch paused by governor: ${code} — ${res.reason || ''}`);
      }

      let waitMs;
      if (code === 'DAILY_FOLLOW_CAP' || code === 'DAILY_ACTION_CAP') {
        waitMs = msUntilNextResume();
        log(`daily cap reached → sleeping ${Math.round(waitMs / 60000)} min until next day's window.`);
      } else if (code === 'WORKING_HOURS') {
        waitMs = msUntilNextResume();
        log(`outside activity window → sleeping ${Math.round(waitMs / 60000)} min until it opens.`);
      } else {
        // ok (did a batch) or HOURLY_CAP → wait for the rolling hour to clear.
        waitMs = jitter(minutes(62));
        log(`hourly budget spent → sleeping ${Math.round(waitMs / 60000)} min for the hour to clear.`);
      }
      await sleep(waitMs);
      continue;
    }

    // ---- Profile busy: another run holds the Chrome lock. Wait it out, not fatal. ----
    if (code === 'PROFILE_LOCKED' || /profile|another instance/i.test(res.reason || '')) {
      log('profile is busy (another run is using Chrome) → waiting 3 min and retrying.');
      await sleep(jitter(minutes(3)));
      continue;
    }

    // ---- Unexpected (error / unparseable / spawn) ----
    consecutiveErrors++;
    log(`unexpected result (${status} ${code}) ${res.reason || ''} [error ${consecutiveErrors}/3]`);
    if (consecutiveErrors >= 3) {
      log('!! 3 consecutive unexpected errors. STOPPING so it can be looked at.');
      process.exit(1);
    }
    await sleep(jitter(minutes(10)));
  }
}

main();
