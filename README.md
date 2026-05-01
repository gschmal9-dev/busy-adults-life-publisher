# Busy Adults Life — Cloud Instagram Publisher

Auto-publishes Reels from `./shorts/` to Instagram via the Meta Graph API.
Runs as a GitHub Actions cron job — completely independent of your local machine.

## Schedule

GitHub Actions cron triggers (UTC):
- `0 7 * * *`  → 09:00 CEST / 08:00 CET
- `0 13 * * *` → 15:00 CEST / 14:00 CET

The script picks the next unposted file (by numeric prefix `1_`, `2_`, ...) and posts it.
A 5h dedup guard prevents double-posts.

You can also trigger a run manually from the **Actions** tab → **"Daily Instagram Publisher"** → **"Run workflow"**.

## How it works

```
GitHub Actions (cron) ──▶ Run publisher.js
                              │
                              ├─▶ List ./shorts/ → pick next unposted (vs .posted-shorts.json)
                              ├─▶ Generate caption + hashtags via Claude (sarcastic, on-brand)
                              ├─▶ Compress with ffmpeg if > 80MB
                              ├─▶ Upload to tmpfiles.org → public URL
                              ├─▶ Meta Graph API: create REELS container, poll, publish
                              └─▶ Commit updated .posted-shorts.json back to repo
```

## Adding new shorts

1. Drop new MP4s into `./shorts/` with numeric prefix (`11_my-new-short.mp4`, `12_...`)
2. Commit + push
3. Next cron run picks them up automatically

## Required GitHub Secrets

Set these in **Repo Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Description |
|--------|-------------|
| `META_ACCESS_TOKEN` | Long-lived Meta user token (60-day expiry — refresh monthly) |
| `IG_USER_ID`        | Instagram Business Account ID (e.g. `17841480639457014`) |
| `ANTHROPIC_API_KEY` | Anthropic API key (for caption generation) |

## Token refresh (every 60 days)

Run locally:
```bash
node extend-meta-token.js   # extends current short-lived → 60-day long-lived
```
Then update the `META_ACCESS_TOKEN` secret in GitHub.

## Manual commands

```bash
npm install
npm run status       # show what's posted vs remaining
npm run dry          # generate caption + upload but DON'T post (test)
npm run start        # post next unposted reel (with dedup)
npm run force        # bypass dedup, post next unposted now
```

## State

`.posted-shorts.json` tracks what's been posted. The workflow auto-commits it after each successful post.
Each entry includes filename, timestamp, Media ID, permalink URL, and the full caption.
