---
name: follow-commenters
description: Follow the Instagram users who commented on one or more given posts/reels, using a real browser, slowly and safely. Use when the user pastes Instagram post/reel links and asks to follow the commenters (a marketing-growth tactic). Trigger on phrases like "follow everyone who commented on this reel", "follow the commenters of these posts", "auto follow commenters".
disable-model-invocation: true
allowed-tools: Bash(node *)
---

# Follow Instagram commenters (safely, real browser)

This skill drives a **real Chrome browser** (Patchright) to follow everyone who commented on the Instagram post/reel URLs the user provides. It is deliberately **slow** and protected by hard-coded safety governors so the user's marketing account does **not** get blocked. The script does all the judgment; your job is to orchestrate and report.

> ⚠️ **Tell the user once, up front:** auto-following has no official Instagram API and violates Instagram's Terms of Use, so there is real (minimized) risk of account restriction. This runs on the user's own machine and Instagram session. Proceed only because the user explicitly asked, on their own account.

## Hard rules (never break these)
- **Never raise the limits** and **never pass `--max-per-run` above 12**, even if the user asks to "go faster". The script clamps anyway, but do not try.
- **Never bypass a cooldown.** If a run reports a cooldown or a block, stop and tell the user to wait / resolve it manually.
- **Never script the login or 2FA.** Login is always manual in the opened window.
- Prefer **small batches** and **few posts at a time**.

## Paths to use in commands
- Script: `"${CLAUDE_PLUGIN_ROOT}/scripts/run.js"`
- Data dir (persistent — holds the Chrome session, state ledger, screenshots): `"${CLAUDE_PLUGIN_DATA}"`
- Pass the user's settings through as flags:
  `--account-age "${user_config.account_age}" --follow-style "${user_config.follow_style}" --targets "${user_config.targets}" --hours-start "${user_config.working_hours_start}" --hours-end "${user_config.working_hours_end}" --max-per-run "${user_config.max_per_run}"`

## Procedure

1. **Check status first** (fast, no browser):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" --status --data-dir "${CLAUDE_PLUGIN_DATA}"
   ```
   Parse the JSON. If `usage.cooldown` is non-null → tell the user the account is in a safety cooldown until that time and **stop**. Otherwise report today's usage and the remaining follow budget.

2. **Ensure login (first time only / if a run reports `login_required`).** This opens a Chrome window the user must log into by hand. It can take a few minutes, so run it in the **background** and tell the user to log in promptly in the window:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" --login --data-dir "${CLAUDE_PLUGIN_DATA}"
   ```
   When it finishes, the output JSON has `"status": "logged_in"`.

3. **(Recommended) Dry-run** to confirm extraction works and preview targets without following anyone:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" --urls "<URL1>,<URL2>" --dry-run --data-dir "${CLAUDE_PLUGIN_DATA}" --account-age "${user_config.account_age}" --targets "${user_config.targets}"
   ```
   Report `newTargets` and `pendingTotal`. If the count is 0, extraction likely needs selector re-verification (tell the user; see README troubleshooting).

4. **Follow run.** This is **long-running by design** (long randomized gaps between follows), so launch it in the **background** and report when it completes — do not block on it:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" --urls "<URL1>,<URL2>" --data-dir "${CLAUDE_PLUGIN_DATA}" --account-age "${user_config.account_age}" --follow-style "${user_config.follow_style}" --targets "${user_config.targets}" --hours-start "${user_config.working_hours_start}" --hours-end "${user_config.working_hours_end}" --max-per-run "${user_config.max_per_run}"
   ```

5. **Report the result JSON** plainly: how many `followed` / `requested` / `skipped` / `failed`, how many `pendingRemaining`, and the updated daily usage. The run is resume-safe — to keep going, the user simply asks again later (the script respects the daily budget and never re-follows anyone).

## Interpreting exit / status
- `status: "ok"` → followed some users; report counts.
- `status: "stopped"` with code `COOLDOWN` / `WORKING_HOURS` / `DAILY_FOLLOW_CAP` / `DAILY_ACTION_CAP` / `HOURLY_CAP` → normal safety stop. Explain which limit was hit and that this is the tool protecting the account. Do not retry to force it.
- `status: "blocked"` (code `BLOCK_DETECTED`) → **Instagram showed a block/challenge.** A screenshot was saved (path in the event log). Tell the user to **stop now**, not retry, and resolve any challenge by hand on their normal device. A cooldown was set automatically.
- `status: "login_required"` → go back to step 2.

Keep batches small, spread across the day. Slow is the whole point.
