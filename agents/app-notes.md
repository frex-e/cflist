# CFList App Notes

## Data Sources

References:

- Codeforces API docs: https://codeforces.com/apiHelp
- API behavior note from Codeforces admin: https://codeforces.com/blog/entry/153241#comment-1364127

- `contest.list?gym=false`: official non-gym contest metadata.
- `problemset.problems`: official regular problem list and solved counts.
- `user.status?handle=<account cfHandle>`: accepted submissions for per-account solved status.
- `contest.standings`: not used. Anonymous regular-contest standings access is restricted to `contestId`-only requests, and gym/mashup standings need authenticated access from a permitted user.

Gyms, `acmsguru`, and other non-regular sources are excluded.

Codeforces API calls should remain serialized with at least a two-second delay between requests.

## Solved State

Users sign in with local email/password auth through Better Auth. Each user stores a required `cfHandle` on the auth user record. Codeforces handles are profile data only; app-owned state is keyed by auth `user.id`, so two accounts can use the same handle without sharing local data.

Effective solved state is:

```text
Codeforces accepted submission status OR local solved override
```

Important constraints:

- A local override may mark an unsolved problem as solved.
- A local override can be cleared, which falls back to Codeforces status.
- Manual overrides are additive; they do not represent local "unsolved" state.
- API-solved rows are non-clickable in the list.
- `contests`, `problems`, and `problem_tags` are shared catalog data.
- `user_problem_status`, `user_problem_overrides`, and `user_default_filters` are keyed by auth `user_id`.
- Existing pre-auth databases do not need migration; deleting `data/cflist.sqlite` is acceptable.

## UI Behavior

- Server-rendered UI lives in Hono TSX views under `src/views/`.
- Filters are URL-backed and should remain shareable/bookmarkable.
- Tags are hidden in the table unless `showTags=1`.
- Division and tag filters are checkbox lists.
- Rating filter uses sliders backed by hidden `minRating` / `maxRating` fields.
- Problem id/name links go directly to the contest-scoped Codeforces problem page; there is no local problem detail page.
- Bare `/problems` applies the signed-in user's saved default filters from SQLite when one is set. Explicit query params still win.
- Problem solved toggles use normal forms with JS enhancement:
  - without JS: form POST redirects back
  - with HTMX: the POST returns a server-rendered row and swaps it in place
- Problem filters use normal GET forms with JS enhancement:
  - without JS: form submission and pager links reload `/problems`
  - with HTMX: filter changes fetch `/problems/fragment`, swap the table, and update the canonical URL
- Rating slider changes update hidden GET fields and trigger the HTMX filter refresh automatically.
- Tag mode defaults to `any`; `tagMode=all` is only included in URLs when explicitly selected.
- Sort direction is URL-backed through `sortDirection=asc|desc` and rendered as an asc/desc toggle button.
- The problem table has an HTMX infinite-scroll sentinel. Reaching the bottom fetches the next `/problems/fragment?append=1` page and appends rows.
- With JS enabled, the table label is cumulative, e.g. `Showing 1-100 of 11,245`, and pager links are hidden. Pager links remain as the no-JS fallback.
- The filter panel scrolls with the page, not independently.

## Deployment Notes

- `HOST` defaults to `127.0.0.1`; Docker sets `HOST=0.0.0.0`.
- `DB_PATH` defaults to `./data/cflist.sqlite`.
- Set `BETTER_AUTH_SECRET` or `AUTH_SECRET` to a random 32+ byte value outside local development.
- Set `BETTER_AUTH_URL` or `AUTH_BASE_URL` to the public origin in deployment.
- The app is designed for one Node process plus one persisted SQLite file. If multiple instances ever run, move sync to a separate command/cron or add a database lock.

## Design Tradeoffs

- Keep the app server-rendered and URL-backed; avoid adding a client-side app model unless the UI clearly needs it.
- Contest family/division values are best-effort labels derived from contest names. Preserve raw contest names and keep `Unknown`/`Other` filter paths visible.
- `raw_json` fields in the database are intentional; they preserve source API payloads for future UI needs without immediate migrations.
- Use Node's built-in test runner. Current high-value test areas are contest classification, solved-status conversion, SQL/filter behavior, and HTMX row fragments.
