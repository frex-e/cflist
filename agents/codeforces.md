# Codeforces API

References:

- API docs: https://codeforces.com/apiHelp
- Behavior note: https://codeforces.com/blog/entry/153241#comment-1364127

## Endpoints

- `contest.list?gym=false`: official non-gym contest metadata.
- `problemset.problems`: official regular problem list and solved counts.
- `user.status?handle=<account cfHandle>`: accepted submissions for per-account solved status and upsolve detection.
- `user.rating?handle=<account cfHandle>`: rated contest history for rank and official rating deltas.
- `contest.ratingChanges?contestId=<id>`: rated participant ranks/ratings used to estimate per-contest performance.
- `contest.standings?contestId=<id>`: full public standings for user row score, penalty, participant type, and per-problem contest results for recent contests. Non-gym standings reject extra parameters such as `handles`, so filter locally.

Gyms, `acmsguru`, and other non-regular sources are excluded.

Serialize API calls with at least a two-second delay between requests.
