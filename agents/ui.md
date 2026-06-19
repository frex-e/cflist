# UI behavior

Server-rendered Hono TSX views under `src/views/`. `filters.js` loads only on `/problems` (rating slider, direction label, Set default save).

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
- Solved toggles: without JS, POST redirects back to `/problems` (or `returnTo`); with HTMX, POST re-renders `#problem-list` and summary so rows disappear under filters like `solved=unsolved`.
- Filter forms: without JS, GET submission and pager links reload `/problems`; with HTMX, changes fetch `/problems/fragment`, swap the table, and update the canonical URL.
- `Set default` posts to `/preferences/default-filters`; JS intercepts for inline status, `formmethod`/`formaction` fallback redirects without JS.
- HTMX infinite-scroll sentinel appends `/problems/fragment?append=1` pages at the bottom.
- With JS: cumulative table label (e.g. `Showing 1-100 of 11,245`), pager links hidden. Pager remains the no-JS fallback.
- Filter panel scrolls with the page, not independently.

## Contests page

`/contests` shows recent synced contest rows with rank, score, rating delta, estimated performance, and per-problem solve/upsolve pills.
