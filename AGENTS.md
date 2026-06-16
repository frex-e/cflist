# Agent Notes

Keep this file and the `agents/` directory updated when changes alter architecture, commands, data flow, deployment, or important UI behavior. Prefer concise notes over long process docs.

## Project

CFList is a small personal Codeforces problem index.

- Runtime: Node.js 24+ with TypeScript.
- Web app: Hono, server-rendered HTML.
- Database: SQLite through Node's built-in `node:sqlite`.
- Frontend: Hono TSX server views, plain CSS, HTMX for HTML fragment swaps, and small vanilla JS in `src/public/filters.js`.
- Persistent local state: `data/cflist.sqlite` (gitignored).

## Commands

```sh
npm install
npm run build
npm test
npm start
```

Common dev server:

```sh
PORT=3001 npm start
```

## Important Files

- `agents/app-notes.md`: compact implementation notes for future agents.
- `src/app.ts`: routes and write-route guards.
- `src/db/queries.ts`: filter parsing, SQL queries, solved override writes.
- `src/cf/sync.ts`: Codeforces sync.
- `src/views/problems.tsx`: problem list rendering.
- `src/public/filters.js`: client-side rating slider and filter reset helper; HTMX owns fragment swaps.

## External References

- Codeforces API docs: https://codeforces.com/apiHelp
- Codeforces API behavior note: https://codeforces.com/blog/entry/153241#comment-1364127

## Rules Of Thumb

- Keep the app small: avoid new frameworks unless there is a clear reason.
- Preserve URL-backed filters.
- Treat Codeforces solved status as authoritative; local manual solves are additive.
- Keep JavaScript enhancements progressive; forms should still work without JS.
- Run `npm test` after behavior changes.
