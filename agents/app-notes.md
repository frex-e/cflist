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

- Filters are URL-backed and should remain shareable/bookmarkable.
- Tags are hidden in the table unless `showTags=1`.
- Division and tag filters are checkbox lists.
- Rating filter uses sliders backed by hidden `minRating` / `maxRating` fields.
- Problem solved toggles use normal forms with JS enhancement:
  - without JS: form POST redirects back
  - with JS: `src/public/filters.js` updates the row in place
- The filter panel scrolls with the page, not independently.

## Deployment Notes

- `HOST` defaults to `127.0.0.1`; Docker sets `HOST=0.0.0.0`.
- `DB_PATH` defaults to `./data/cflist.sqlite`.
- `ADMIN_TOKEN` is optional; if set, write routes require it.
