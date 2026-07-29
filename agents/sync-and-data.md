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
- Overrides are keyed by `(user_id, canonical_id)` — one toggle applies to all contest placements of the same task.

## Canonical problem identity

Problems list dedup uses `problems.canonical_id`, not rating/tags metadata.

- **Catalog sync** (`problemset.problems`): each row gets a fresh UUID `canonical_id`.
- **Standings import**: look up the paired round contest; if a row with the same `name` exists there, reuse its `canonical_id`; otherwise assign a new UUID.
- **Round pairs**: Div. 1 + Div. 2 contests with the same `start_time_seconds` (`contest_round_pairs`, refreshed on catalog sync). Same `name` within a pair → shared `canonical_id` (linked after catalog upsert via `linkCanonicalIdsByRoundPairs`).
- Solo rounds (Global, Educational, unpaired Div. 2) keep one id per problem row.
- If the partner contest is not hydrated yet, standings rows may get a new id until a later sync links them by name.
- Contest history, CF URLs, `user_problem_status`, and `problem_tags` stay `(contest_id, problem_index)` scoped.

## Tags

- **Filtering** uses normalized `problem_tags` rows (`EXISTS` / `IN` queries).
- `problems.tags_json` is a denormalized display cache from the API on upsert; not used for list dedup.
- Metadata refresh targets rows with `rating IS NULL` or no `problem_tags` rows (not `tags_json = '[]'`).

## Tables

- Shared catalog: `contests`, `problems`, `problem_tags`, `contest_round_pairs`.
- Per-user (`user_id`): `user_problem_status`, `user_problem_overrides`, `user_contest_results`, `user_contest_problem_results`, `user_default_filters`.
- Sync caches: full `contest_rating_changes_cache` responses plus `contest_performance_cache` (keyed by `contest_id`, `user_id`). Full standings are never cached.
- `contest_sync_jobs`: SQLite-backed low-priority queue drained in small batches by the web process (one user/contest row at a time).

## Sync pipeline

User sync refreshes catalog when the problem table is empty or the last successful catalog sync is older than `SYNC_INTERVAL_MINUTES`, and also forces a catalog refresh when user data references contests missing locally. Between full catalog syncs, a lighter metadata refresh runs when local problems still lack a rating or tags: it re-fetches `problemset.problems` and updates only rows where Codeforces now has metadata. That pass uses `SYNC_UNRATED_INTERVAL_MINUTES` (default 60) and is skipped when a full catalog sync is due. User sync and the server background timer both call this path. It then refreshes solved status and basic contest rows from `user.rating`, and queues standings hydration for all contests that still need it. Queue priority is recency rank in the user's contest list (0 = newest). Contest participation is discovered from `user.rating` plus contests with accepted submissions.

- Hydration calls `contest.standings` with `handles=<current handle>`. Codeforces still returns the full problem list, but only matching participant rows; the app imports standings-only problems and stores only normalized per-user contest/problem results.
- Skips complete existing contest rows by comparing their problem-pill count with the known `problems` count for that contest. Standings-only problems imported by the first hydration therefore participate in later completeness checks. Cheap upsolve flags are still recomputed from `user.status`.
- **Standings corrections:** `user_contest_results.standings_checked_at` records the last successful filtered hydration and is not changed by basic `/user.rating` sync. On each user sync, compare `/user.rating` against stored results. When rank or ratings differ (e.g. cheater bans), clear the relevant user's standings freshness, delete that contest's full rating-change and performance caches, clear stored performance, and re-queue hydration. A TTL on recent contests (`CONTEST_CACHE_TTL_DAYS`, default 14, checked for the `CONTEST_CACHE_RECENT_COUNT` newest, default 10) checks per-user standings freshness; rated contests additionally require a fresh full rating-change cache, while unrated/upsolve-only contests do not. Settings → **Refresh contest details** applies the same invalidation and re-queues all of that user's contests without wiping solved status.
- After enqueueing hydration jobs, user sync drains recently enqueued jobs (top 30 by recency) before finishing so the first sync click can populate new upsolve pills. Older backfill jobs stay in the background queue.
- Commits catalog, solved-status, and basic rating updates before contest refresh work. Queued contest rows are written one contest at a time as each result is calculated.
- Contest problem pills classify solved-in-contest from standings rows and upsolves from accepted submissions after contest end. Accepted submissions expand through `problems.canonical_id`, so a shared Div. 1/Div. 2 task is solved in both simultaneous placements (or upsolved in both when accepted after the round), even when the indices differ. Exact Codeforces status remains stored under the submitted contest/index; canonical expansion is derived for contest discovery and hydration. If a submission-discovered contest has no exact standings row for the handle, accepted submissions still provide fallback solved/upsolved pills while rank/score stay blank.
- Accepted submissions and standings can include contest-scoped problems absent from `problemset.problems`, especially shared Div. 1/Div. 2 rounds. User sync imports missing accepted problems from submission metadata, expands canonical aliases again, and adds newly discovered placements to the same sync's hydration candidates before writing `user_problem_status`.
- When an accepted problem belongs to a paired Div. 1/Div. 2 round but no partner alias is catalogued yet, user sync probes the paired contest through hydration without first creating a blank `user_contest_results` row. Hydration imports standings problems, reloads canonical acceptances, and only persists the counterpart when a shared accepted task is found.

## Referential integrity

- `problems.contest_id` → `contests(id)`; `user_problem_status` → `problems(contest_id, problem_index)`.
- `sync_runs.user_id` → `"user"(id)` with `ON DELETE SET NULL`.
- Orphan rows are cleaned before FK migrations (`src/db/migrate-audit.ts`).
- `cf_handle` is not stored on `user_problem_status` / `user_contest_results`; join `"user".cfHandle` when needed. Kept on `sync_runs` / `contest_sync_jobs` for observability.

## Migrations

Pre-auth databases can be deleted instead of migrated. Schema changes use versioned steps in `src/db/migrate.ts` (`schema_migrations` table). v6 adds `canonical_id` and re-keys overrides; v7 adds FKs, CHECK constraints, indexes, and performance-cache user key; v8 re-pairs Div. 1/Div. 2 rounds by start time and links canonical ids; v9 adds/backfills per-user standings freshness and drops the full standings cache table.
