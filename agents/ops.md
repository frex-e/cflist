# Operations and design

## Deployment

- `HOST` defaults to `127.0.0.1`; Docker sets `HOST=0.0.0.0`.
- `DB_PATH` defaults to `./data/cflist.sqlite`.
- Set `BETTER_AUTH_SECRET` or `AUTH_SECRET` to a random 32+ byte value outside local development. The server refuses to start in production without it.
- Set `BETTER_AUTH_URL` or `AUTH_BASE_URL` to the public HTTPS origin in production. The server refuses localhost/127.0.0.1 values when `NODE_ENV=production`.
- Optional GitHub OAuth: set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a GitHub OAuth App. Register callback URL `{AUTH_BASE_URL}/api/auth/callback/github`. Ensure `BETTER_AUTH_URL` matches the public origin exactly or OAuth redirects will fail. `NODE_ENV=production` disables email/password sign-in by default (GitHub-only); set `AUTH_GITHUB_ONLY=false` to keep email/password in production. GitHub sign-in creates new accounts and sends new users to `/complete-profile` for a Codeforces handle. GitHub and email/password are separate sign-in paths and are not linked when emails match.
- Optional catalog repair admin: set `ADMIN_EMAILS` to a comma-separated allowlist (case-insensitive). Matching signed-in users can open `/admin/catalog` for soft repair (clear estimates, drop rating-change cache, force all-user contest rehydration). Empty/unset disables the page (404). Contest/problem rows are never deleted from this UI.
- One Node process plus one persisted SQLite file. If multiple instances ever run, move contest queue draining to a separate command/cron or add a database lock.
- `/healthz` returns `{ ok: true }` when the DB is reachable; use it as a liveness/readiness probe.
- The process handles `SIGTERM`/`SIGINT`: stops background sync timers, closes the HTTP server, then closes the DB.
- Request logs include mutations, failed reads, and reads taking at least one second. Routine successful `GET`/`HEAD`/`OPTIONS` traffic and health checks are suppressed; health-check failures have a dedicated error log.

## Backups

SQLite runs in WAL mode (`PRAGMA journal_mode = WAL`). To back up safely:

1. Prefer copying the database while the app is stopped, or
2. Run `PRAGMA wal_checkpoint(TRUNCATE)` on a live connection, then copy `cflist.sqlite` along with any `-wal` / `-shm` sidecar files if they still exist.

A naive `cp` of only the main `.sqlite` file while the app is writing can produce an inconsistent snapshot.

## Standings disk / request note

Do not reintroduce an uncompressed `contest_standings_cache` of full API payloads — that grew to ~1 GB for a single user. Regular contests only allow bare `contest.standings?contestId=…` (no per-handle filter); see [codeforces.md](./codeforces.md) and the storage vs request section in [sync-and-data.md](./sync-and-data.md).

If an old local DB still has leftover free pages after dropping that cache, reclaim with offline `VACUUM` (stop the app first): `sqlite3 data/cflist.sqlite 'VACUUM;'`.

## Feature / UI demonstrations

When adding a new feature or UI element, demonstrate it in the running app before considering the work done. Prefer a short screen recording that uses the feature end-to-end; use screenshots when the change is static. Attach or link the artifacts in the PR/walkthrough summary.

Use the shared test account and live synced data (not fake DB rows):

1. Ensure the seed ran (`npm run seed:test-user` if needed).
2. Sign in as `test@cflist.local` / `cflist-test-password` (or the configured `TEST_USER_*` overrides).
3. Open Problems or Contests so background sync can pull real Codeforces data for handle `inj`.
4. Exercise the new control/flow with that real data and capture the demo.

Do not inject synthetic problems, contests, standings, or solved overrides into SQLite just for a walkthrough or recording. Hand-written rows often miss real column shapes, sync timing, estimated ratings, and contest hydration behavior. Keep synthetic fixtures in automated tests (`npm test`); use live synced data for agent/manual demos.

## Design tradeoffs

- Server-rendered and URL-backed; avoid a client-side app model unless the UI clearly needs it.
- Contest family/division values are best-effort labels from contest names. Preserve raw contest names; keep `Unknown`/`Other` filter paths visible.
- `raw_json` fields preserve source API payloads for future UI needs without immediate migrations. Prefer not to store multi‑MB contest standings blobs this way.
- Use Node's built-in test runner. High-value areas: contest classification, solved-status conversion, SQL/filter behavior, HTMX row fragments.
