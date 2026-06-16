# CFList Architecture Plan

## Goal

Build a small personal web app that indexes official Codeforces problems, supports fast filtering/browsing, links out to Codeforces problem pages, tracks solved status for the hardcoded handle `inj`, and can refresh itself when Codeforces adds new contests/problems.

This is intentionally not a large SaaS architecture. The app should be easy to run locally, easy to deploy on one small VM/container, and understandable without many framework layers.

## External Data Sources

Use the public Codeforces API anonymously wherever possible.

- `problemset.problems`
  - Source of truth for the official problemset.
  - Returns `problems` and `problemStatistics`.
  - Each problem has `contestId`, `index`, `name`, optional `rating`, `tags`, `type`, and optional `points`.
  - Each statistic has `contestId`, `index`, and `solvedCount`.
- `contest.list?gym=false`
  - Source of contest metadata for regular Codeforces contests.
  - Provides contest `id`, `name`, scoring `type`, `phase`, duration, start time, and related metadata.
  - Version 1 deliberately excludes gyms.
- `user.status?handle=inj`
  - Source of solved status.
  - Any submission with `verdict === "OK"` marks its `problem.contestId + problem.index` as solved.
- `contest.standings`
  - Do not depend on this for the first version.
  - As of the June 2026 docs/admin comment, regular public contests only allow an anonymous request with exactly `contestId`; gym/mashup standings require authenticated access from a user who can view the contest. This is relevant only if we later add standings/ranklist-derived features.

Respect the Codeforces API limit of one request per two seconds. The sync process should serialize CF API calls and sleep between them.

## Proposed Stack

Use a small server-rendered TypeScript app:

- Runtime: Node.js 24+.
- Web framework: Hono.
- Database: SQLite via Node's built-in `node:sqlite`.
- Frontend: server-rendered HTML, plain CSS, and small vanilla TypeScript for table interactions only where it improves ergonomics.
- Build/dev tooling: TypeScript, `tsx` for dev, `esbuild` for the small browser script if needed.

Why this stack:

- One deployable Node process plus one SQLite file.
- No React/Next/Prisma/Tailwind stack unless we later decide the UI needs it.
- No native SQLite package to compile; Node provides the SQLite binding.
- Server-side filtering keeps the client simple and makes URLs shareable.
- SQLite is enough for tens of thousands of problems/submissions and gives permanent state without running Postgres.

## App Shape

Recommended directory layout:

```text
.
├── docs/
│   └── ARCHITECTURE_PLAN.md
├── src/
│   ├── app.ts                 # Hono app, routes, HTML rendering
│   ├── server.ts              # process entrypoint
│   ├── config.ts              # env defaults: DB path, handle, sync interval
│   ├── db/
│   │   ├── connection.ts      # SQLite connection
│   │   ├── migrate.ts         # idempotent schema setup
│   │   └── queries.ts         # SQL query helpers
│   ├── cf/
│   │   ├── client.ts          # rate-limited Codeforces API client
│   │   ├── classify.ts        # contest type/division derivation from contest names
│   │   └── sync.ts            # refresh problems, contests, solved status
│   ├── views/
│   │   ├── layout.ts          # HTML shell
│   │   └── problems.ts        # problem list page and list fragment
│   └── public/
│       ├── styles.css
│       └── filters.js         # progressive filter/list enhancements
├── data/
│   └── cflist.sqlite          # ignored local DB
├── package.json
├── Dockerfile
└── README.md
```

## Database Schema

SQLite tables:

```sql
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT
);

CREATE TABLE contests (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  phase TEXT,
  duration_seconds INTEGER,
  start_time_seconds INTEGER,
  year INTEGER,
  derived_family TEXT,
  derived_division TEXT,
  derived_label TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE problems (
  contest_id INTEGER NOT NULL,
  problemset_name TEXT,
  problem_index TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  points REAL,
  rating INTEGER,
  solved_count INTEGER,
  tags_json TEXT NOT NULL,
  url TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (contest_id, problem_index)
);

CREATE TABLE problem_tags (
  contest_id INTEGER NOT NULL,
  problem_index TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (contest_id, problem_index, tag)
);

CREATE TABLE user_problem_status (
  handle TEXT NOT NULL,
  contest_id INTEGER NOT NULL,
  problem_index TEXT NOT NULL,
  solved INTEGER NOT NULL DEFAULT 0,
  first_accepted_submission_id INTEGER,
  first_accepted_at_seconds INTEGER,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT NOT NULL,
  PRIMARY KEY (handle, contest_id, problem_index)
);

CREATE INDEX idx_problems_rating ON problems(rating);
CREATE INDEX idx_problems_solved_count ON problems(solved_count);
CREATE INDEX idx_problem_tags_tag ON problem_tags(tag);
CREATE INDEX idx_contests_derived ON contests(derived_family, derived_division);
CREATE INDEX idx_user_status_handle_solved ON user_problem_status(handle, solved);
```

Notes:

- `problems` is keyed by `contest_id + problem_index` because that is the stable Codeforces identity for normal problemset problems.
- `raw_json` keeps us resilient to future UI needs without requiring immediate migrations.
- `problemset_name` is stored for completeness, but version 1 should only show official regular Codeforces contest/problemset problems. Exclude gyms, `acmsguru`, and other non-regular sources.
- Tags are stored both as JSON for easy rendering and normalized in `problem_tags` for filtering.

Manual solved overrides:

```sql
CREATE TABLE user_problem_overrides (
  handle TEXT NOT NULL,
  contest_id INTEGER NOT NULL,
  problem_index TEXT NOT NULL,
  solved_override INTEGER,
  note TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (handle, contest_id, problem_index)
);
```

- `solved_override = 1` marks a problem solved locally even if Codeforces submissions do not.
- `solved_override = 0` marks a problem unsolved locally even if Codeforces says solved.
- `solved_override IS NULL` or no row means use Codeforces-derived solved status.
- The UI should show whether solved status came from Codeforces or from a local override.

## Sync Strategy

Provide both automatic and manual sync:

- On server startup:
  - Run migrations.
  - If DB is empty, start a background full sync.
  - Otherwise serve immediately and start a background refresh if data is older than the configured interval.
- Manual route:
  - `POST /admin/sync` starts a background sync and redirects back to the index.
  - Use `ADMIN_TOKEN` protection if set. If `ADMIN_TOKEN` is unset, allow the route for local/dev simplicity.
- Periodic sync:
  - Use `setInterval` in the single Node process.
  - Default interval: 6 hours.

Full sync flow:

1. Call `contest.list?gym=false`.
2. Upsert contests and derive filterable contest categories from contest names.
3. Wait at least two seconds.
4. Call `problemset.problems`.
5. Filter out gyms, `acmsguru`, and other non-regular problem sources. Upsert regular official problems, stats, tags, and URLs.
6. Wait at least two seconds.
7. Call `user.status?handle=inj`.
8. Rebuild solved status from accepted submissions.
9. Preserve local solved overrides.
10. Record `sync_runs` status and show latest sync state in the UI.

For `user.status`, start with one full fetch. If the API response becomes too large or unreliable, add incremental paging later using `from`/`count` and store max seen submission id.

## Contest Classification

Codeforces contest metadata has a scoring `type` such as `CF`, `ICPC`, or `IOI`, but it does not directly expose labels like Div. 1 or Educational. We should derive those from `contest.name`.

Store:

- `derived_family`: `Codeforces Round`, `Educational`, `Global`, `Divisional`, `Kotlin Heroes`, `April Fools`, `Other`.
- `derived_division`: `Div. 1`, `Div. 2`, `Div. 3`, `Div. 4`, `Div. 1 + Div. 2`, `Unrated`, `Unknown`.
- `derived_label`: a display label combining the useful parsed pieces.

Implementation should be conservative:

- Prefer simple regexes over a complex taxonomy.
- Always preserve raw contest name.
- Include an `Unknown/Other` filter option so classification gaps are visible instead of hidden.

## Routes

Core routes:

- `GET /`
  - Redirect to `/problems`.
- `GET /problems`
  - Filterable, paginated problem table.
  - Query params:
    - `q`
    - `minRating`
    - `maxRating`
    - `tags`
    - `tagMode=all|any`
    - `contestFamily`
    - `division`
    - `solved=all|solved|unsolved`
    - `sort=rating|solvedCount|contest|name`
    - `page`
    - `pageSize`
- Problem rows link directly to Codeforces problem URLs instead of local detail pages.
- `POST /problems/:contestId/:index/override`
  - Set or clear a local solved override.
- `POST /admin/sync`
  - Start refresh.
- `GET /healthz`
  - Basic deployment health check.

All filter state should live in the URL so pages are bookmarkable/shareable.

## UI Plan

The UI should be a dense, practical index, closer to a spreadsheet/database view than a marketing page.

Problem list:

- Left/top filter bar with:
  - search box
  - rating min/max inputs or compact selects
  - tag multiselect/checklist
  - contest family/division selects
  - solved state segmented control
  - sort select
- Main table columns:
  - solved indicator
  - problem id (`1900A`)
  - name
  - rating
  - tags
  - contest type/division
  - solved count
  - problem links that open Codeforces directly
- Small summary row:
  - total matched problems
  - solved/unsolved counts in current filter
  - latest sync time

## Deployment

Target simplest deployment:

- `npm install`
- `npm run build`
- `npm start`

Environment variables:

- `PORT=3000`
- `DB_PATH=./data/cflist.sqlite`
- `CF_HANDLE=inj`
- `SYNC_INTERVAL_MINUTES=360`
- `ADMIN_TOKEN=` optional shared secret for sync/override write routes

Docker option:

- Single `Dockerfile`.
- Mount `/app/data` as a volume to persist SQLite:

```sh
docker run -p 3000:3000 -v cflist-data:/app/data cflist
```

No external database required.

## Testing Strategy

Keep tests focused:

- Unit tests for contest-name classification.
- Unit tests for converting CF submissions into solved status.
- Integration-ish tests for SQL filtering using an in-memory/temp SQLite DB.
- Avoid mocking the entire Codeforces API unless sync code grows complex.

Use Node's built-in test runner to avoid pulling in a large test framework.

## Known Tradeoffs

- Server-rendered HTML is less flashy than a SPA, but better matches the requirement for a small personal tool.
- A single-process scheduler is enough for a small deployment. If multiple app instances ever run, move sync to a separate command/cron or use a DB lock.
- Contest type/division filters are best-effort because Codeforces exposes contest names, not a formal Div. 1/Div. 2 enum.
- Codeforces-derived solved status is public-submission based. Manual local overrides cover cases where you want the app's status to differ from Codeforces.
- This plan avoids `contest.standings` entirely in version 1, so the recent standings restrictions do not block the core app.

## Open Questions

Resolved for version 1:

- Exclude gyms.
- Exclude `acmsguru` and other non-regular sources.
- Include manual local solved overrides.
- Protect write/admin routes with `ADMIN_TOKEN` when configured; allow them without a token in local/dev mode.

Remaining:

1. Should manual solved overrides support admin-token entry directly in the list?
2. Should `ADMIN_TOKEN` be required in production-like deployments, or just documented as strongly recommended?
