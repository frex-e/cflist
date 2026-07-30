# Agent Notes

Keep this file and `agents/` updated when architecture, commands, data flow, deployment, or important UI behavior changes. Prefer concise notes over long process docs.

## Project

CFList is a small personal Codeforces problem index: Node.js 24+ / TypeScript, Hono server-rendered HTML, SQLite (`node:sqlite`), Better Auth (email/password + optional GitHub OAuth). HTMX + plain CSS + `src/public/filters.js` on the problems page. Local DB: `data/cflist.sqlite` (gitignored).

## Commands

```sh
npm install
npm run build
npm test
npm start
```

Dev server: `PORT=3001 npm start`

## Documentation

Detailed notes live in [`agents/`](./agents/README.md) by topic (Codeforces API, sync/data, UI, ops).

## Entry points

- `src/app.ts` — app factory, middleware, routes
- `src/routes/` — auth, problems, contests
- `src/db/queries/` — filters and SQL (barrel: `src/db/queries.ts`)
- `src/cf/sync/` — Codeforces sync (barrel: `src/cf/sync.ts`)
- `src/views/problems.tsx` — problem list (`src/views/problems/url.ts` for URLs)

## Rules of thumb

- Keep the app small; avoid new frameworks without a clear reason.
- Preserve URL-backed filters; interactive Problems/Contests UI requires JavaScript (HTMX + page scripts).
- Codeforces solved status is authoritative; local manual solves and skips are additive.
- Import contest-scoped problems from standings when `problemset.problems` omits them.
- If a submission-discovered contest lacks a matching standings row, keep rank/score blank but use accepted submissions for contest problem pills.
- Key app-owned user data by auth user id, not Codeforces handle.
- Official problem `rating` wins when present; otherwise show clist-style `estimated_rating` (only after contest end + rating changes). Cap estimates at the max official rating tag. Shared Div. 1/Div. 2 placements use a combined-field estimate (same value on both rows). Never estimate during a live contest.
- When adding a new feature or UI element, show a demonstration that exercises it — a screen recording or a screenshot is fine. Sign in as the shared test account and sync real Codeforces data; do not inject fake rows into the DB just for the demo.
- Run `npm test` after behavior changes.

## Cursor Cloud specific instructions

- Node 24+ is required (uses stable `node:sqlite`). The VM's default `node` on `PATH` (`/exec-daemon/node`) is v22; Node 24 is installed via `nvm` and prepended to `PATH` in `~/.bashrc`, so run commands in a login shell (e.g. `bash -lc '...'`) or a fresh `tmux` login shell to get v24. Verify with `node --version` before building/running.
- Copy `.env.example` to `.env` before running (already done in this VM). The app also boots on defaults, but auth callbacks expect `BETTER_AUTH_URL=http://localhost:3000`.
- Dev server: `npm run dev` (tsx watch), serves `http://127.0.0.1:3000`. Home and `/problems` redirect to `/sign-in` until authenticated; sign-up (`/sign-up`) needs name, email, password, and a real Codeforces handle (e.g. `tourist`). Health check: `GET /healthz` → `{"ok":true}`.
- No dedicated lint script; type-checking is `npm run build` (`tsc`). `npm test` builds first, then runs `node --test`; the `Codeforces sync failed: database is not open` lines during tests are expected teardown noise, not failures.
- Shared test user: `npm run seed:test-user` idempotently seeds a throwaway login (Codeforces handle `inj`) through Better Auth into `DB_PATH`. Credentials default to `test@cflist.local` / `cflist-test-password` (override with `TEST_USER_EMAIL`/`TEST_USER_PASSWORD`, password ≥8 chars). It's a no-op when the user already matches and recreates the user if the password/handle drifted. The startup update script runs it (`--if-present`), so every new VM can sign in at `/sign-in` with those defaults. Sign-in needs no network; the first `/problems` visit still triggers a background Codeforces sync for `inj`. The `WARN [Better Auth]: Invalid password` line only appears during the self-heal path (probing the old password) and is expected.
- Feature/UI demos: after shipping a new feature or UI element, demonstrate it in the running app with a screen recording or a screenshot. Sign in as the test user and let sync pull real Codeforces data. Do not hand-insert fake problems, contests, standings, or solves into SQLite just to screenshot or walk through the UI—fake rows drift from real shapes and miss sync/edge-case behavior. Reserve synthetic DB fixtures for automated tests. Include the demo artifacts in the PR/walkthrough summary.
