# instagram-follower

A [Claude Code](https://code.claude.com) plugin that opens a **real browser** and **slowly** follows everyone who commented on the Instagram post(s)/reel(s) you give it — with hard-coded anti-block safety governors so a precious account does not get blocked.

This repository is also a **Claude Code plugin marketplace**: the plugin lives in [`instagram-follower/`](./instagram-follower) and is listed in [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json).

> ⚠️ **Terms of Use:** auto-following has **no** official Instagram API and **violates Instagram's Terms of Use**. There is real risk of account restriction or permanent loss despite every precaution. Use only on your own account, from your own machine, at your own risk.

## Install

```text
/plugin marketplace add fed3c3sa/instagram-follower
/plugin install instagram-follower@secondbrain-tools
/plugin enable instagram-follower
```

Then tell Claude, e.g. *"follow everyone who commented on https://www.instagram.com/reel/XXXX/"*. On first use you log in to Instagram **by hand** once in the Chrome window it opens (no credentials are ever stored or scripted).

## How it stays safe

- **One identity:** a single real Chrome (`channel:'chrome'`) via [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) (CDP-leak-patched Playwright), headful, with a **persistent profile**. No proxy/VPN (that looks *more* automated on a real account) → runs on your own machine/IP.
- **Code-enforced governor:** caps follows per hour / per day / combined per day / per run, restricts to a waking-hours window, and paces 40–120 s between follows with bursts + long pauses. These can't be lifted by asking Claude.
- **Instant block tripwire:** any "action blocked" / "please wait" / challenge screen → stop, screenshot, 48 h cooldown, exit. Never auto-retries or auto-solves challenges; resumes at half limits afterward.
- **Resume-safe ledger:** never re-follows anyone; resumes exactly where it stopped.

Full docs, limits table, warm-up guide, and troubleshooting: **[`instagram-follower/README.md`](./instagram-follower/README.md)**.

## Develop / run directly

```bash
cd instagram-follower
npm install
npx patchright install chrome
node scripts/run.js --login                                   # one-time manual login
node scripts/run.js --urls "https://www.instagram.com/reel/XXXX/" --dry-run
node scripts/run.js --urls "https://www.instagram.com/reel/XXXX/"
npm test                                                       # unit tests (no browser)
```

## License

[MIT](./LICENSE)
