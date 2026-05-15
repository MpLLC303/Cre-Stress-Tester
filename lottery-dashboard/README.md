# Colorado Lottery Scratch Dashboard

Self-refreshing static dashboard that pulls the Colorado Lottery Scratch
Insider feed daily and renders a bookmarkable `index.html` with EV
rankings, prize tier breakdowns, filters, and charts.

## Layout

```
lottery-dashboard/
  scraper.py                  ► data pipeline + HTML render
  requirements.txt
  templates/dashboard.html.j2 ► Jinja template for index.html
  index.html                  ► generated output (open this)
  status.html                 ► generated only on hard failure
  data/
    current.json              ► last enriched snapshot
    history.jsonl             ► daily snapshots, append-only
    refresh_log.jsonl         ► run log fed back into the footer
    scratch_insider_YYYY-MM-DD.xlsx
    game_pages/{game_number}.html|.meta.json
  logs/scraper.log
  scripts/
    setup.sh                  ► macOS + Linux installer
    uninstall.sh              ► removes scheduled job
    setup_windows.ps1         ► Windows installer
    com.lottery.dashboard.plist ► template, paths filled in by setup.sh
```

## First-time install

The repo was built in an isolated container, so the bundled `index.html`
was rendered from the included sample dataset (the lottery host blocks
non-allowlisted traffic from CI). To get live data and a real scheduled
refresh on your own machine:

1. Copy this directory to `~/lottery-dashboard/` (or `C:\lottery-dashboard\` on Windows).
2. Run the installer:
   ```
   bash scripts/setup.sh                   # macOS + Linux
   powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1   # Windows
   ```
   The installer creates `.venv`, installs deps, registers the daily 6 AM
   job, and runs `scraper.py` once so a fresh `index.html` exists right away.
3. Bookmark `file://$HOME/lottery-dashboard/index.html`.

## Manual refresh

```
.venv/bin/python scraper.py        # macOS / Linux
.venv\Scripts\python.exe scraper.py   # Windows
```

After the run, `index.html` rewrites with a new timestamp; `data/history.jsonl`
gets a new row per game; `data/refresh_log.jsonl` gets one entry. The
footer table on the page surfaces the last 20 runs.

## Verify the scheduled job

```
launchctl list | grep lottery               # macOS
crontab -l | grep lottery                   # Linux
schtasks /query /tn LotteryDashboard        # Windows
```

## Uninstall the scheduled job

```
bash scripts/uninstall.sh                       # macOS / Linux
schtasks /delete /tn LotteryDashboard /f        # Windows
```

Data files are left in place; delete the directory to remove them.

## Logs

► `logs/scraper.log`           — every scraper run, INFO level
► `logs/launchd.out.log`       — macOS LaunchAgent stdout
► `logs/launchd.err.log`       — macOS LaunchAgent stderr
► `data/refresh_log.jsonl`     — structured per-run summary (also rendered in the page footer)

## How EV is computed

For each game:

► `pct_top_prizes_remaining` = `top_prizes_remaining / total_top_prizes`
► `pct_total_prize_pool_remaining` = Σ(remaining × prize) / Σ(total × prize) across every parsed tier. If the game page tiers cannot be parsed, this falls back to `pct_top_prizes_remaining`.
► `conditional_ev_per_dollar` = `payout_percentage × pct_total_prize_pool_remaining`
► `ev_score` = conditional EV with the following multiplicative haircuts:
  ► × 0.90 if `days_to_claim_deadline < 180`
  ► × 0.75 if `days_to_claim_deadline < 90` (this replaces, not stacks with, the 180-day haircut)
  ► × 0.95 if `days_since_launch > 365`

Default sort is `ev_score` descending. Click any column header to resort,
click again to flip direction. Click any row to expand the per-tier
breakdown and a prefilled Winning Stores lookup at ZIP 80501 / 5 mi.

## Failure handling

► XLSX 200 with binary content → parse it.
► XLSX non-200 or HTML → fall back to scraping the Scratch Insider HTML page.
► Both fail and a prior `index.html` exists → keep the prior file and write `status.html` with the failure banner.
► Both fail and no prior `index.html` → render from the bundled sample dataset so the dashboard is visually inspectable on day one. The footer alert makes this explicit.

## Documented default choices

► Game slug for the per-game URL is derived from the game name via simple
  lowercase + non-alphanumeric collapse. If a game page 404s, that game
  keeps its top-prize-only EV (no tier breakdown).
► Conditional GET uses both `If-Modified-Since` and `If-None-Match` if the
  prior response sent either header. 304 responses re-use the cached HTML
  on disk; the rate limit (1 req/sec) is still applied to be polite.
► "Active games" = every row in the Scratch Insider feed; the feed itself
  is the source of truth for what is active.
► The Winning Stores deep link uses `since-game-start` implicitly by virtue
  of the official tool defaulting to that scope when a game number is set.
► Formatting: arrowhead bullets (►), no em/en dashes, ASCII-safe.

## Container note

The dashboard ships with a working `index.html` rendered from sample data
because the build environment cannot reach `coloradolottery.com`. After
running `scripts/setup.sh` on your own machine the next scheduled run (or
a manual run) replaces it with live data.
