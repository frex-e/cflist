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
- De-duplicates shared contest aliases by problem metadata after filters; aggregates solved state across the visible alias group. Contest history preserves contest-specific indices.
- Solved toggles POST and re-render `#problem-list` plus summary via HTMX so rows disappear under filters like `solved=unsolved`. Filter context comes from the `HX-Current-URL` header.
- Filter changes fetch `/problems/fragment`, swap the table, and update the canonical URL.
- `Set default` posts to `/preferences/default-filters` via `fetch` in `filters.js` for inline status.
- HTMX infinite-scroll sentinel appends `/problems/fragment?append=1` pages at the bottom.
- Cumulative table label during scroll (e.g. `Showing 1-100 of 11,245`).
- Filter panel scrolls with the page, not independently.

## Contests page

`/contests` shows recent synced contest rows with rank, score, rating delta, estimated performance, and per-problem solve/upsolve pills.

## Sync panel

- Shared `SyncPanel` on Problems and Contests; `POST /admin/sync` starts background sync and returns panel HTML.
- Panel polls `GET /admin/sync/panel` every 3s while user sync or contest hydration is active.
- On Problems, successful sync completion refreshes `#problem-list` and summary via `sync.js`.
- On Contests, hydration polling refreshes `#contests-table` from `GET /contests/fragment`.
- First visit with no prior user sync shows a banner on Problems and auto-starts sync on first full page load of Problems or Contests.
- Contest rows show `Loading…` / `Could not load` (with error tooltip) while hydration jobs run or fail.
