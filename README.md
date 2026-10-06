# ai-sandbox-dashboard

Observation page for the DefiDash protocol-onboarding pipeline. **Read-only**: nothing can be
done from here; decisions are made with `sandboxctl` or the Telegram buttons.

Live: https://detracker.github.io/ai-sandbox-dashboard/

## How it works

```
ai-sandbox box                          this repository                  GitHub Pages
sandboxctl export ──(every 2 min)──>    branch data: snapshot.json  <──fetch──  branch main: page
      (deploy key with write access)     single-commit history                 (index.html/app.js)
```

The page fetches the snapshot from `raw.githubusercontent.com`, not from its own branch.
Pages has a soft limit of **10 builds per hour**, and the snapshot changes every two minutes —
kept in a built branch, the limit would run out within an hour. The `data` branch is never
built, so there are no rebuilds at all. The price is the `raw` cache (up to ~5 minutes), so the
snapshot age is always shown in the header.

The `data` branch intentionally has a single commit (`git commit --amend` +
`push --force-with-lease`): a state snapshot needs no history, and 720 commits a day would turn
the repository into a dump.

## What the page shows

Three tabs; the tab and the filters live in `#hash`, so a view can be shared as a link:

- **Instruments** (default) — everything collected into the analytics database: added by the
  agents and the legacy collection. The status is derived from data freshness (collectors run
  every 8 h): 🟢 collecting, 🔵 backfilling history (with %), 🟠 lagging (> 10 h),
  🔴 stalled (> 26 h or no data), ⚪ disabled. Filters: status (counter chips), source,
  protocol, search. The "how it's collected" (spec or collector code), MR and decisions links
  point to private repositories and open for the team only. The registry is recomputed on the
  box every 10 minutes.
- **Pipeline** — the funnel (discovered → screened out → in progress → awaiting decision →
  implemented → collecting), what awaits a decision, what is running now, history with a filter.
- **Log** — runs filtered by stage and result, spend over 24 hours, accesses.

## The repository is public — what follows

The snapshot is built from a **field whitelist** on the box
(`detracker/ai-sandbox:orchestrator/export.py`) and checked before writing: if it contains an
RPC endpoint, an IP, a host path, a home directory, a token prefix or a key, the file is not
written at all. Only `doctor` check names and `ok`/`fail` leave the box, never the reasons.

Protocol names are visible by default — a product signal of what is being onboarded next; turn
them off with `public_names: false` on the box (links are dropped as well then).

## Local preview

```bash
python3 -m http.server 8000   # then http://localhost:8000
# on your own snapshot: put snapshot.json next to the page and open
# http://localhost:8000/?snapshot=snapshot.json   (relative paths only)
```

No build step and no dependencies: `index.html`, `app.js`, `style.css`.
