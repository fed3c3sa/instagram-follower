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

// The source posts/reels to re-scrape when the pending queue drains (dry-run =
// extract only, no follows) so the loop keeps harvesting new commenters. These are
// the operator's own campaign links and are NEVER committed: they live in a
// gitignored local file (one URL per line, '#' comments allowed). Path can be
// overridden with IG_SOURCE_URLS_FILE. If the file is missing/empty, re-scrape is
// skipped and the loop simply stops when the queue is empty.
// upsertTarget never downgrades a terminal status, so already followed/requested/
// failed users are NOT re-queued — only genuinely new commenters.
const SOURCE_URLS_FILE = process.env.IG_SOURCE_URLS_FILE || path.join(DATA_DIR, 'source-urls.txt');

function loadSourceUrls() {
  try {
    return fs
      .readFileSync(SOURCE_URLS_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .join(',');
  } catch (_) {
    return '';
  }
}

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

// 00:00–00:00 = a 24h window (governor treats equal start/end as always-on), so the
// uncapped run is never paused by the working-hours gate.
const WINDOW_ARGS = ['--hours-start', '00:00', '--hours-end', '00:00'];

/** Spawn run.js with the given args; resolve with the parsed result JSON (from stdout). */
function runRun(args) {
  return new Promise((resolve) => {
    const child = spawn('node', [RUN, ...args], {
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

/** One governed follow batch over the existing pending queue. */
const runOnce = () => runRun(['--follow-pending', ...WINDOW_ARGS]);

/** Re-scrape the source posts (extract only, no follows) to add new commenters.
 *  Returns {status:'no_sources'} if no source-urls file is configured. */
const runRescrape = () => {
  const urls = loadSourceUrls();
  if (!urls) return Promise.resolve({ status: 'no_sources' });
  return runRun(['--urls', urls, '--dry-run', ...WINDOW_ARGS]);
};

let totalFollowed = 0;
let totalRequested = 0;
let emptyRescrapes = 0; // consecutive re-scrapes that found nothing new

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
      // Queue drained → re-scrape the source posts to harvest any commenters that
      // arrived since (and any the earlier scroll missed), then keep going. Only stop
      // once two consecutive re-scrapes add nothing new.
      const re = await runRescrape();
      if (re.status === 'no_sources') {
        log(`✅ DONE — pending queue empty and no source-urls file (${SOURCE_URLS_FILE}) to re-scrape. Cumulative this loop: ${totalFollowed} followed, ${totalRequested} requested.`);
        process.exit(0);
      }
      log('queue empty → re-scraping the configured source posts for new commenters…');
      if (re.status === 'blocked' || re.code === 'BLOCK_DETECTED') {
        log(`!! BLOCK/CHALLENGE during re-scrape (${re.reason || ''}). STOPPING — do NOT restart; let it rest.`);
        process.exit(10);
      }
      if (re.code === 'COOLDOWN') {
        log('!! In cooldown during re-scrape. STOPPING — let it rest.');
        process.exit(10);
      }
      if (re.status === 'login_required') {
        log('!! Login required during re-scrape. STOPPING — re-login by hand, then restart the loop.');
        process.exit(3);
      }
      const added = typeof re.newTargets === 'number' ? re.newTargets : 0;
      if (added > 0) {
        emptyRescrapes = 0;
        log(`re-scrape added ${added} NEW targets (total pending ${re.pendingTotal}) → continuing follows.`);
        await sleep(jitter(minutes(1)));
        continue;
      }
      emptyRescrapes++;
      log(`re-scrape found no new commenters (empty #${emptyRescrapes}/2).`);
      if (emptyRescrapes >= 2) {
        log(`✅ DONE — queue empty and re-scrape yields nothing new. Cumulative this loop: ${totalFollowed} followed, ${totalRequested} requested.`);
        process.exit(0);
      }
      // Give fresh comments time to appear before trying again.
      log('sleeping 20 min before the next re-scrape attempt.');
      await sleep(jitter(minutes(20)));
      continue;
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
      } else if (code === 'HOURLY_CAP') {
        waitMs = jitter(minutes(62));
        log(`hourly cap → sleeping ${Math.round(waitMs / 60000)} min for the hour to clear.`);
      } else {
        // Caps are removed: a plain 'ok' that still leaves pending means the run ended
        // early (not a cap). Resume promptly rather than idling an hour.
        waitMs = jitter(minutes(1.5));
        log(`run ended with ${res.pendingRemaining} pending and no cap hit → resuming in ${Math.round(waitMs / 1000)}s.`);
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
