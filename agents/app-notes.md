# CFList App Notes

## Data Sources

References:

- Codeforces API docs: https://codeforces.com/apiHelp
- API behavior note from Codeforces admin: https://codeforces.com/blog/entry/153241#comment-1364127

- `contest.list?gym=false`: official non-gym contest metadata.
- `problemset.problems`: official regular problem list and solved counts.
- `user.status?handle=<account cfHandle>`: accepted submissions for per-account solved status and upsolve detection.
- `user.rating?handle=<account cfHandle>`: rated contest history for rank and official rating deltas.
- `contest.ratingChanges?contestId=<id>`: rated participant ranks/ratings used to estimate per-contest performance.
- `contest.standings?contestId=<id>`: full public standings used for user row score, penalty, participant type, and per-problem contest results for recent contests. Non-gym standings reject extra parameters such as `handles`, so filter locally.

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
- `user_problem_status`, `user_problem_overrides`, `user_contest_results`, `user_contest_problem_results`, and `user_default_filters` are keyed by auth `user_id`.
- User sync refreshes solved status, up to 30 recent contest result rows, and up to 3 older incomplete contest rows per refresh. Contest participation is discovered from `user.rating` plus in-contest submissions when possible.
- Contest problem pills classify solved-in-contest from standings rows and upsolves from accepted submissions after contest end.
- Shared contest endpoint responses are cached in `contest_rating_changes_cache` and `contest_standings_cache`; performance estimates are cached in `contest_performance_cache`.
- User sync skips complete existing contest rows, recomputes only cheap upsolve flags from `user.status`, and only calculates performance when no cached/user value exists.
- User sync commits catalog and solved-status updates before contest refresh work. Contest rows are then written one contest at a time as each result is calculated.
- Standings can include contest-scoped problems absent from `problemset.problems`, especially shared Div. 1/Div. 2 rounds. User sync imports those standings problems into `problems` before writing `user_contest_problem_results`.
- Existing pre-auth databases do not need migration; deleting `data/cflist.sqlite` is acceptable.

## UI Behavior

- Server-rendered UI lives in Hono TSX views under `src/views/`.
- Filters are URL-backed and should remain shareable/bookmarkable.
- Tags are hidden in the table unless `showTags=1`.
- Division and tag filters are checkbox lists.
- Rating filter uses sliders backed by hidden `minRating` / `maxRating` fields.
- Problem id/name links go directly to the contest-scoped Codeforces problem page; there is no local problem detail page.
- `/problems` de-duplicates shared contest aliases by problem metadata after applying filters, and aggregates solved state across the visible alias group. Contest history still preserves contest-specific problem indices.
- `/contests` shows recent synced contest rows with rank, score, rating delta, estimated performance, and per-problem solve/upsolve pills.
- Bare `/problems` applies the signed-in user's saved default filters from SQLite when one is set. Explicit query params still win.
- Problem solved toggles use normal forms with JS enhancement:
  - without JS: form POST redirects back
  - with HTMX: the POST returns a server-rendered row and swaps it in place
- Problem filters use normal GET forms with JS enhancement:
  - without JS: form submission and pager links reload `/problems`
  - with HTMX: filter changes fetch `/problems/fragment`, swap the table, and update the canonical URL
- `/problems?default=0` bypasses saved default filters; the Reset link uses it so an existing saved default can be overwritten or cleared.
- `Set default` posts the current filter form to `/preferences/default-filters`; JS keeps the user on the page with inline status, while normal form posts redirect back to `/problems`.
- Default filter saves must parse repeated form fields with `parseBody({ all: true })` so multi-select checkbox groups such as `division` and `tags` are preserved.
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
