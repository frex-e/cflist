# Codeforces API

References:

- API docs: https://codeforces.com/apiHelp
- Standings restriction explanation: https://codeforces.com/blog/entry/153241#comment-1364127

## Endpoints

- `contest.list?gym=false`: official non-gym contest metadata.
- `problemset.problems`: official regular problem list and solved counts.
- `user.status?handle=<account cfHandle>`: accepted submissions for per-account solved status and upsolve detection.
- `user.rating?handle=<account cfHandle>`: rated contest history for rank and official rating deltas.
- `contest.ratingChanges?contestId=<id>`: rated participant ranks/ratings used to estimate per-contest performance.
- `contest.standings?contestId=<id>`: full public standings (problems + every participant row) for score, penalty, participant type, and per-problem contest results.

## `contest.standings` constraints (important)

For **regular / non-gym** contests, anonymous non-admin callers may use **only**:

```text
GET https://codeforces.com/api/contest.standings?contestId=<id>
```

Any extra query parameter fails, including filters that look useful:

- `handles=<handle>` — **not supported** for regular contests (do not use this to “fetch one user”)
- `from` / `count` — also rejected
- authenticated / signed variants of the same call — also rejected for this restricted form

Observed failure comment:

```text
contestId: Non-gym contest standings for non-admin users are available only via
anonymous GET requests with no extra parameters:
https://codeforces.com/api/contest.standings?contestId=<id>
```

Implications for CFList:

- Always request the **full** standings payload, then filter the participant row locally by handle.
- Responses are large (often multi‑MB JSON per contest; tens of thousands of rows on popular rounds).
- Codeforces may cache that bare response for a short time (~1–3 minutes server-side); that does not make per-handle requests available.
- Gym / mashup contests are a different auth path and are out of scope for this app (`gym=false` catalog only).

## Rate limits

Serialize API calls with at least a two-second delay between requests.

Gyms, `acmsguru`, and other non-regular sources are excluded.
