# instagram-follower

A Claude Code plugin that opens a **real browser** and **slowly** follows everyone who commented on the Instagram post(s)/reel(s) you give it — with hard-coded anti-block safety governors so a precious marketing account does not get blocked.

Built for a specific growth tactic: find reels where people discuss your niche (e.g. "second brain" / Obsidian / PKM), and follow the commenters from your brand account so they discover you.

---

## ⚠️ Read this first

- **Auto-following is against Instagram's Terms of Use.** There is **no** official Instagram API for following, so any tool that does this is unsanctioned. Account restriction or permanent loss is possible despite every precaution. You accept that risk.
- This is intended for **your own** account, run from **your own machine**, on **your own** normal home/cellular IP.
- **No proxy / VPN / antidetect browser.** For a genuine precious account, adding those makes it look *more* automated and is a fast checkpoint trigger.
- **Slow is the point.** Defaults are intentionally tiny. Don't raise them.

## How it stays safe (design)

- **One identity:** a single real Google Chrome (`channel:'chrome'`) via **Patchright** (a CDP-leak-patched Playwright), **headful**, with a **persistent profile** so your one-time manual login is reused every run. No credentials are ever stored or scripted.
- **A code-enforced governor** caps follows **per hour**, **per day**, and **combined actions per day**, restricts activity to a **waking-hours window**, and caps **follows per run**. These cannot be lifted by asking Claude.
- **Randomized human pacing:** 40–120 s between follows, bursts of a few then a long 2–5 min pause, engage-then-follow (dwell on each profile first), never fixed intervals.
- **Instant block tripwire:** any "action blocked" / "please wait" / challenge screen → stop everything, screenshot it, set a 48 h cooldown, exit. **Never** auto-retries or auto-solves challenges. After a cooldown it resumes at **half** limits for a few days.
- **Resume-safe ledger:** every target is recorded `pending → followed/requested/skipped/failed`, so it never re-follows anyone and resumes exactly where it stopped.

## Shipped limits (default: `under_6_months` account, extra-safe)

| Setting | Default | Hard cap (clamped) |
|---|---|---|
| Follows / hour | 4 | 5 |
| Follows / day | 25 | 30 |
| Combined actions / day | 40 | 40 |
| Follows / run | 10 | 12 |
| Delay between follows | 40–120 s | — |
| Activity window | 09:00–22:30 local | — |
| Cooldown on a block | 48 h, then ½ limits | 24–72 h |

Set `account_age` to `aged` (6+ months, clean) for slightly higher caps, or `new` for half of these. The only Instagram-official number is the **7,500 standing-follow cap** (concurrent, not lifetime) — stay well under it.

### Recommended manual warm-up for a young account (do BEFORE automating)
- **Days 1–3:** 0 follows. Browse 15–20 min, like 3–5 posts, watch a few stories.
- **Days 4–7:** 3–5 follows/day **by hand**.
- **Week 2:** 5–10/day, start posting. **Week 3:** 10–15/day. **Week 4:** 15–20/day.
- Keep total actions ≤ ~40/day through month 3, then scale slowly.

---

## Install (as a Claude Code plugin)

From the parent folder that contains this plugin and a `.claude-plugin/marketplace.json`:

```
/plugin marketplace add /Users/federicocesarini/Desktop/personal/instagram-follower
/plugin install instagram-follower@secondbrain-tools
/plugin enable instagram-follower
```

On enable you'll be prompted for config (account age, working hours, max per run, follow style, targets). The **SessionStart hook** then installs dependencies (Patchright + Chrome) into the plugin's persistent data dir on first use — the first session may take a minute.

Then just tell Claude, e.g.:
> follow everyone who commented on https://www.instagram.com/reel/XXXX/ and https://www.instagram.com/p/YYYY/

Claude runs the `follow-commenters` skill: status → (first time) manual login → optional dry-run → a slow, governed follow run → reports the counts.

## Use it directly (local dev / power users)

```bash
cd instagram-follower
npm install
npx patchright install chrome

# 1) one-time manual login (opens Chrome; log in by hand)
node scripts/run.js --login

# 2) preview who would be followed (no follows)
node scripts/run.js --urls "https://www.instagram.com/reel/XXXX/" --dry-run

# 3) a real, slow, governed run
node scripts/run.js --urls "https://www.instagram.com/reel/XXXX/,https://www.instagram.com/p/YYYY/"

# check usage / cooldown anytime
node scripts/run.js --status
```

In local dev the runtime data (Chrome profile, state, screenshots) goes to a gitignored `.data/` next to the plugin. When installed as a plugin it uses `${CLAUDE_PLUGIN_DATA}`.

### Useful flags
`--max-per-run N` (≤12) · `--account-age aged|under_6_months|new` · `--follow-style engage_then_follow|follow_only` · `--targets commenters_and_replies|commenters_only` · `--hours-start 09:00 --hours-end 22:30` · `--account NAME` (separate ledger per account) · `--data-dir PATH` · `--dry-run` · `--headless` (testing only — less safe).

## Action-block recovery playbook

1. The tool already stopped and set a cooldown. **Do not run it again** until the cooldown elapses.
2. Open Instagram **on your normal phone/device** and use it like a human for a day or two.
3. If there was a challenge ("confirm it's you"), complete it **manually** on that trusted device.
4. When the cooldown ends, the tool resumes automatically at **half** limits and re-ramps. Don't override that.

## Troubleshooting

- **`Patchright is not installed` / `Could not launch Chrome`** → `npm install && npx patchright install chrome` (or re-open a Claude session so the SessionStart hook runs).
- **Dry-run extracts 0 commenters** → Instagram's DOM changed. Re-verify the selectors in `scripts/selectors.js` using `npx playwright codegen https://www.instagram.com/` and update the `openComments` / `expandMoreControls` / container heuristics. Everything DOM-specific is centralized there.
- **`PROFILE_LOCKED`** → another run (or a leftover Chrome) is using the profile. Close it / wait. Only one run may touch the profile at a time.
- **It "stopped" almost immediately** → you're outside the activity window, in cooldown, or already at today's cap. Run `--status` to see which.

## Project layout

```
.claude-plugin/plugin.json     manifest (defaultEnabled:false, userConfig)
skills/follow-commenters/SKILL.md   the user-triggered entrypoint
scripts/
  run.js               CLI orchestrator (modes, follow loop)
  config.js            tiers, caps, pacing
  state.js             resume-safe ledger + counters + cooldown
  governor.js          enforces caps / hours / pacing
  browser.js           Patchright headful persistent Chrome + profile lock
  login.js             one-time manual login
  selectors.js         ALL Instagram-DOM knowledge (patch here when IG changes)
  extract-commenters.js  bounded comment-dialog scroll + href extraction
  follow.js            engage-then-follow + verify flip
  safety.js            block/challenge tripwire
  deps.js              resolves Patchright from plugin data or local node_modules
  util.js              shared helpers
  test.js              unit tests (governor/state/config/util — no browser)
hooks/hooks.json       SessionStart: install deps + Chrome
```

Run the unit tests with `npm test`.

## License
MIT. Use responsibly and at your own risk.
