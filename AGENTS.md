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
- Codeforces solved status is authoritative; local manual solves are additive.
- Import contest-scoped problems from standings when `problemset.problems` omits them.
- If a submission-discovered contest lacks a matching standings row, keep rank/score blank but use accepted submissions for contest problem pills.
- Key app-owned user data by auth user id, not Codeforces handle.
- Run `npm test` after behavior changes.
