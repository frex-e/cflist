# Operations and design

## Deployment

- `HOST` defaults to `127.0.0.1`; Docker sets `HOST=0.0.0.0`.
- `DB_PATH` defaults to `./data/cflist.sqlite`.
- Set `BETTER_AUTH_SECRET` or `AUTH_SECRET` to a random 32+ byte value outside local development.
- Set `BETTER_AUTH_URL` or `AUTH_BASE_URL` to the public origin in deployment.
- One Node process plus one persisted SQLite file. If multiple instances ever run, move contest queue draining to a separate command/cron or add a database lock.

## Design tradeoffs

- Server-rendered and URL-backed; avoid a client-side app model unless the UI clearly needs it.
- Contest family/division values are best-effort labels from contest names. Preserve raw contest names; keep `Unknown`/`Other` filter paths visible.
- `raw_json` fields preserve source API payloads for future UI needs without immediate migrations.
- Use Node's built-in test runner. High-value areas: contest classification, solved-status conversion, SQL/filter behavior, HTMX row fragments.
