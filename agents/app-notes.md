# CFList App Notes

## Data Sources

References:

- Codeforces API docs: https://codeforces.com/apiHelp
- API behavior note from Codeforces admin: https://codeforces.com/blog/entry/153241#comment-1364127

- `contest.list?gym=false`: official non-gym contest metadata.
- `problemset.problems`: official regular problem list and solved counts.
- `user.status?handle=inj`: accepted submissions for solved status.

Gyms, `acmsguru`, and other non-regular sources are excluded.

## Solved State

Effective solved state is:

```text
Codeforces accepted submission status OR local solved override
```

Important constraints:

- A local override may mark an unsolved problem as solved.
- A local override can be cleared, which falls back to Codeforces status.
- Manual overrides are additive; they do not represent local "unsolved" state.
- API-solved rows are non-clickable in the list.

## UI Behavior

- Server-rendered UI lives in Hono TSX views under `src/views/`.
- Filters are URL-backed and should remain shareable/bookmarkable.
- Tags are hidden in the table unless `showTags=1`.
- Division and tag filters are checkbox lists.
- Rating filter uses sliders backed by hidden `minRating` / `maxRating` fields.
- Problem id/name links go directly to the contest-scoped Codeforces problem page; there is no local problem detail page.
- Bare `/problems` applies the user's saved default filters from a small cookie when one is set. Explicit query params still win.
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
- `ADMIN_TOKEN` is optional; if set, write routes require it.
