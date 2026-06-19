# Sync and data model

## Auth and user keys

Users sign in with local email/password through Better Auth. Each user stores a required `cfHandle` on the auth user record. Handles are profile data only; app-owned state is keyed by auth `user.id`, so two accounts can share a handle without sharing local data.

## Solved state

```text
Codeforces accepted submission status OR local solved override
```

- A local override may mark an unsolved problem as solved.
- A local override can be cleared, which falls back to Codeforces status.
- Manual overrides are additive; they do not represent local "unsolved" state.
- API-solved rows are non-clickable in the list.

## Tables

- Shared catalog: `contests`, `problems`, `problem_tags`.
- Per-user (`user_id`): `user_problem_status`, `user_problem_overrides`, `user_contest_results`, `user_contest_problem_results`, `user_default_filters`.
- Sync caches: `contest_rating_changes_cache`, `contest_standings_cache`, `contest_performance_cache`.
- `contest_sync_jobs`: SQLite-backed low-priority queue drained in small batches by the web process (one user/contest row at a time).

## Sync pipeline

User sync refreshes catalog only when the problem table is empty or the last successful catalog sync is older than `SYNC_INTERVAL_MINUTES`, then refreshes solved status and basic contest rows from `user.rating`, and queues standings hydration for up to 30 recent contests plus up to 3 older incomplete contests per refresh. Contest participation is discovered from `user.rating` plus contests with accepted submissions.

- Skips complete existing contest rows; recomputes only cheap upsolve flags from `user.status`; leaves performance/standings work to queued hydration.
- Commits catalog, solved-status, and basic rating updates before contest refresh work. Queued contest rows are written one contest at a time as each result is calculated.
- Contest problem pills classify solved-in-contest from standings rows and upsolves from accepted submissions after contest end. If a submission-discovered contest has no exact standings row for the handle, accepted submissions still provide fallback solved/upsolved pills while rank/score stay blank.
- Standings can include contest-scoped problems absent from `problemset.problems`, especially shared Div. 1/Div. 2 rounds. User sync imports those standings problems into `problems` before writing `user_contest_problem_results`.

## Migrations

Pre-auth databases can be deleted instead of migrated. Schema changes use versioned steps in `src/db/migrate.ts` (`schema_migrations` table).
