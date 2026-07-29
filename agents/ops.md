# Operations and design

## Deployment

- `HOST` defaults to `127.0.0.1`; Docker sets `HOST=0.0.0.0`.
- `DB_PATH` defaults to `./data/cflist.sqlite`.
- Set `BETTER_AUTH_SECRET` or `AUTH_SECRET` to a random 32+ byte value outside local development. The server refuses to start in production without it.
- Set `BETTER_AUTH_URL` or `AUTH_BASE_URL` to the public HTTPS origin in production. The server refuses localhost/127.0.0.1 values when `NODE_ENV=production`.
- Optional GitHub OAuth: set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a GitHub OAuth App. Register callback URL `{AUTH_BASE_URL}/api/auth/callback/github`. Ensure `BETTER_AUTH_URL` matches the public origin exactly or OAuth redirects will fail. `NODE_ENV=production` disables email/password sign-in by default (GitHub-only); set `AUTH_GITHUB_ONLY=false` to keep email/password in production. GitHub sign-in creates new accounts and sends new users to `/complete-profile` for a Codeforces handle. GitHub and email/password are separate sign-in paths and are not linked when emails match.
- One Node process plus one persisted SQLite file. If multiple instances ever run, move contest queue draining to a separate command/cron or add a database lock.
- `/healthz` returns `{ ok: true }` when the DB is reachable; use it as a liveness/readiness probe.
- The process handles `SIGTERM`/`SIGINT`: stops background sync timers, closes the HTTP server, then closes the DB.
- Request logs include mutations, failed reads, and reads taking at least one second. Routine successful `GET`/`HEAD`/`OPTIONS` traffic and health checks are suppressed; health-check failures have a dedicated error log.

## Backups

SQLite runs in WAL mode (`PRAGMA journal_mode = WAL`). To back up safely:

1. Prefer copying the database while the app is stopped, or
2. Run `PRAGMA wal_checkpoint(TRUNCATE)` on a live connection, then copy `cflist.sqlite` along with any `-wal` / `-shm` sidecar files if they still exist.

A naive `cp` of only the main `.sqlite` file while the app is writing can produce an inconsistent snapshot.

## One-time standings-cache disk reclamation

Migration v9 drops `contest_standings_cache`, so SQLite can reuse those pages immediately, but the database file does not shrink automatically. After deploying v9:

1. Back up the database using the guidance above.
2. Stop the app so no process is using the database.
3. Run `sqlite3 data/cflist.sqlite 'VACUUM;'` (substitute the configured `DB_PATH`).
4. Restart the app.

`VACUUM` is intentionally not run during startup: it can block startup and temporarily needs substantial free disk while rebuilding the file.

## Design tradeoffs

- Server-rendered and URL-backed; avoid a client-side app model unless the UI clearly needs it.
- Contest family/division values are best-effort labels from contest names. Preserve raw contest names; keep `Unknown`/`Other` filter paths visible.
- `raw_json` fields preserve source API payloads for future UI needs without immediate migrations.
- Use Node's built-in test runner. High-value areas: contest classification, solved-status conversion, SQL/filter behavior, HTMX row fragments.
