# UI behavior

Server-rendered Hono TSX views under `src/views/`. `filters.js` loads only on `/problems` (rating slider, direction label, Set default save). Problems and Contests show a `<noscript>` banner; interactive UI requires JavaScript.

## Filters and URLs

- Filters are URL-backed and shareable/bookmarkable.
- Tags are hidden unless `showTags=1`.
- Division and tag filters are checkbox lists.
- Rating filter uses sliders backed by hidden `minRating` / `maxRating` fields; changes update hidden GET fields and trigger HTMX filter refresh.
- Tag mode defaults to `any`; `tagMode=all` is only included when explicitly selected.
- Sort direction is URL-backed through `sortDirection=asc|desc` (asc/desc toggle button).
- Bare `/problems` applies the signed-in user's saved default filters when set. Explicit query params win.
- `/problems?default=0` bypasses saved defaults; Reset uses it so an existing default can be overwritten or cleared.
- Default filter saves must parse repeated form fields with `parseBody({ all: true })` so multi-select groups (`division`, `tags`) are preserved.

## Problems page

- Problem id/name links go to the contest-scoped Codeforces problem page; no local detail page.
- Search (`q`) matches problem names, ids such as `1900A`, and raw contest names.
- De-duplicates shared Div. 1/Div. 2 aliases by `canonical_id` (round pairing + same problem name) after filters; aggregates CF solved state and manual overrides across the alias group. Contest history preserves contest-specific indices.
- Solved toggles POST and re-render `#problem-list` plus summary via HTMX so rows disappear under filters like `solved=unsolved`. Override is stored per `canonical_id` (all placements share one toggle). Filter context comes from the `HX-Current-URL` header.
- Filter changes fetch `/problems/fragment`, swap the table, and update the canonical URL.
- `Set default` posts to `/preferences/default-filters` via `fetch` in `filters.js` for inline status.
- HTMX infinite-scroll sentinel appends `/problems/fragment?append=1` pages at the bottom. `infinite-scroll.js` loads the next page when the user scrolls it into view (one page per scroll position, no auto-cascade).
- Cumulative table label during scroll (e.g. `Showing 1-100 of 11,245`).
- Filter panel scrolls with the page, not independently.

## Contests page

`/contests` shows contest rows with rank, score, rating delta, estimated performance, and per-problem solve/upsolve pills when synced. Pill pastel fill encodes solve state (green tint = in contest, teal tint = upsolved, gray tint = unsolved); left stripe uses vivid Codeforces problem rating tier colors.

- Table show control is a 4-way segment: `All`, `Participated`, `Rated`, `Upsolved` (lexicographic). URL param `show=upsolved|participated|rated` (`All` omits it). `All` lists past catalog contests that have at least one problemset problem (`problems` row), LEFT JOINing user standings when present; catalog-only rows show unsolved problem pills from the problems index. Upsolved/Participated/Rated stay limited to synced user history. Rating/performance charts always plot every rated contest (`new_rating IS NOT NULL`), independent of table filter and pagination.
- HTMX infinite-scroll sentinel appends `/contests/fragment?append=1` pages at the bottom (fixed page size 50). `infinite-scroll.js` loads the next page when the user scrolls it into view (one page per scroll position, no auto-cascade).
- Cumulative table label during scroll (e.g. `Showing 1-50 of 237`). Filter changes reset to page 1.

## Sync panel

- Shared `SyncPanel` on Problems and Contests; `POST /admin/sync` starts background sync and returns panel HTML.
- Panel polls `GET /admin/sync/panel` every 3s while user sync or contest hydration is active.
- On Problems, successful sync completion refreshes `#problem-list` and summary via `sync.js`.
- On Contests, sync completion and hydration polling refresh `#contests-table` from `GET /contests/fragment`. The sync panel sets `HX-Trigger: refreshContestsTable` on successful HTMX panel responses; `sync.js` handles that event plus panel state changes.
- First visit with no prior user sync shows a banner on Problems and auto-starts sync on first full page load of Problems or Contests.
- Contest rows keep catalog problem pills visible with an inline `Loading…` spinner while hydration jobs run; failed jobs show `Could not load` with an error tooltip.

## Settings

- `/settings` (signed in, handle required) shows account info, reset CF data, and delete account.
- Topbar handle link goes to `/settings`; handle changes remain at `/settings/handle`.
- Reset/delete require typing the current Codeforces handle to confirm.
- Reset clears per-user CF sync tables and audit rows, keeps saved filter defaults, and starts a fresh sync.
- Delete account cascades all user data, signs out, and redirects to sign-in.
