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

## Estimated problem ratings

When Codeforces has not published an official problem `rating` yet, CFList may store a clist-style `estimated_rating` (Elo expected-solves binary search over the rated field from `contest.ratingChanges`, using in-contest solve counts from standings when available).

- `problems.rating` stays official-only; estimates never overwrite it.
- Eligibility: contest ended (`start + duration <= now`), phase is `FINISHED` when set (never `CODING` / system-test phases), and non-empty rating changes exist. Live-contest hydration may import problems but must not estimate. Both hydration and the metadata estimate pass prefer fresh `standings.contest` over a possibly stale DB contest row (metadata only cheap-skips when the DB end time is still in the future).
- Primary trigger: after contest hydration once rating changes are available.
- Secondary: metadata refresh one-shot for unrated rows still missing an estimate (fetches standings for in-contest solve counts; does not use catalog `solved_count`, which includes upsolves). Does not recalculate every hour once an estimate exists.
- Estimates are capped at the highest official problem `rating` already in the catalog (fallback 3500), so unsolved/extreme Elo fits never exceed the max rating tag.
- Shared Div. 1 / Div. 2 placements (same `canonical_id` via round pairs) get one estimate: when both contests’ rating changes + standings are available, use the combined rated field and write that value to both rows. If only one side is available, use that field and provisionally copy to the sibling so the deduped problems list and both contest pill rows agree; later sync upgrades to the combined value.
- When an official rating arrives via catalog/metadata upsert, `estimated_rating` is cleared.
- UI/filters use `COALESCE(rating, estimated_rating)`; estimated values display as `~1500`.

## Tables

- Shared catalog: `contests`, `problems`, `problem_tags`, `contest_round_pairs`.
- Per-user (`user_id`): `user_problem_status`, `user_problem_overrides`, `user_contest_results`, `user_contest_problem_results`, `user_default_filters`.
- Sync caches: full `contest_rating_changes_cache` responses plus `contest_performance_cache` (keyed by `contest_id`, `user_id`). Full standings JSON is **not** persisted (see storage note below).
- `contest_sync_jobs`: SQLite-backed low-priority queue drained in small batches by the web process (one user/contest row at a time).

## Sync pipeline

User sync refreshes catalog when the problem table is empty or the last successful catalog sync is older than `SYNC_INTERVAL_MINUTES`, and also forces a catalog refresh when user data references contests missing locally. Between full catalog syncs, a lighter metadata refresh runs when local problems still lack a rating or tags: it re-fetches `problemset.problems` and updates only rows where Codeforces now has metadata. That pass uses `SYNC_UNRATED_INTERVAL_MINUTES` (default 60) and is skipped when a full catalog sync is due. User sync and the server background timer both call this path. It then refreshes solved status and basic contest rows from `user.rating`, and queues standings hydration for all contests that still need it. Queue priority is recency rank in the user's contest list (0 = newest). Contest participation is discovered from `user.rating` plus contests with accepted submissions.

Manual Sync (`POST /admin/sync`) is limited to one start per `USER_SYNC_INTERVAL_MINUTES` (default 60) after a successful user sync. The cooldown is keyed by auth user id and the latest successful `sync_runs` row (`source = codeforces:user`). Failed syncs may be retried immediately. Initial first-visit sync, handle change, and reset CF data call `runSyncInBackground` directly and are not rate-limited.

- Hydration calls bare `contest.standings?contestId=<id>` (no `handles` / paging params — regular contests reject them; see [codeforces.md](./codeforces.md)). The response includes the full problem list and all participant rows; the app filters the current handle locally, imports standings-only problems, and stores only normalized per-user contest/problem results, then discards the payload.
- Skips complete existing contest rows by comparing their problem-pill count with the known `problems` count for that contest. Standings-only problems imported by the first hydration therefore participate in later completeness checks. Cheap upsolve flags are still recomputed from `user.status`.
- **Standings corrections:** `user_contest_results.standings_checked_at` records the last successful hydration and is not changed by basic `/user.rating` sync. On each user sync, compare `/user.rating` against stored results. When rank or ratings differ (e.g. cheater bans), clear the relevant user's standings freshness, delete that contest's full rating-change and performance caches, clear stored performance, and re-queue hydration. A TTL on recent contests (`CONTEST_CACHE_TTL_DAYS`, default 14, checked for the `CONTEST_CACHE_RECENT_COUNT` newest, default 10) checks per-user standings freshness; rated contests additionally require a fresh full rating-change cache, while unrated/upsolve-only contests do not. Settings → **Refresh contest details** applies the same invalidation and re-queues all of that user's contests without wiping solved status.

## Standings storage vs request volume

Persisting raw `contest.standings` blew up disk (~1 GB with one active user) because each popular contest is multi‑MB of participant rows. The API also cannot return “just my row,” so every hydration downloads the full payload.

Tradeoff chosen: **do not cache full standings**; keep only normalized `user_contest_*` rows (and rating-change / performance caches).

Does that mean too many Codeforces requests?

- **First backfill** is the expensive part: one standings GET per contest that needs pills/details, serialized at ≥2 s. A heavy history (hundreds of contests) is many minutes and lots of bandwidth once, then done.
- **Routine sync** does **not** re-fetch every contest. Complete rows are skipped; only incomplete contests, correction invalidations, and the newest `CONTEST_CACHE_RECENT_COUNT` (default 10) when their per-user `standings_checked_at` is older than `CONTEST_CACHE_TTL_DAYS` (default 14) are re-queued.
- **Multi-user** no longer shares a standings blob cache, so two accounts hydrating the same contest each pay one GET. For a personal / small deploy that is acceptable; if user count grows, prefer a short-lived in-memory LRU of recent standings or gzipped on-disk cache — not uncompressed raw JSON.
- Gzip of a ~10 MB standings body is often ~0.4 MB; if disk caching returns, store compressed bytes (or only `problems` + needed rows), never the old plain `raw_json` table.
- After enqueueing hydration jobs, user sync drains recently enqueued jobs (top 30 by recency) before finishing so the first sync click can populate new upsolve pills. Older backfill jobs stay in the background queue.
- Commits catalog, solved-status, and basic rating updates before contest refresh work. Queued contest rows are written one contest at a time as each result is calculated.
- Contest problem pills classify solved-in-contest from standings rows and upsolves from accepted submissions after contest end. Accepted submissions expand through `problems.canonical_id`, so a shared Div. 1/Div. 2 task is solved in both simultaneous placements (or upsolved in both when accepted after the round), even when the indices differ. Exact Codeforces status remains stored under the submitted contest/index; canonical expansion is derived for contest discovery and hydration. If a submission-discovered contest has no exact standings row for the handle, accepted submissions still provide fallback solved/upsolved pills while rank/score stay blank.
- Accepted submissions and standings can include contest-scoped problems absent from `problemset.problems`, especially shared Div. 1/Div. 2 rounds. User sync imports missing accepted problems from submission metadata, expands canonical aliases again, and adds newly discovered placements to the same sync's hydration candidates before writing `user_problem_status`.
- When an accepted problem belongs to a paired Div. 1/Div. 2 round but no partner alias is catalogued yet, user sync probes the paired contest through hydration without first creating a blank `user_contest_results` row. Hydration imports standings problems, reloads canonical acceptances, and only persists the counterpart when a shared accepted task is found.

## Referential integrity

- `problems.contest_id` → `contests(id)`; `user_problem_status` → `problems(contest_id, problem_index)`.
- `sync_runs.user_id` → `"user"(id)` with `ON DELETE SET NULL`.
- `cf_handle` is not stored on `user_problem_status` / `user_contest_results`; join `"user".cfHandle` when needed. Kept on `sync_runs` / `contest_sync_jobs` for observability.

## Schema bootstrap

`src/db/migrate.ts` creates the current schema with `CREATE TABLE IF NOT EXISTS`, then applies small additive upgrades (e.g. `ALTER TABLE … ADD COLUMN`) for columns introduced after a database already existed. Fresh installs get the full schema from bootstrap; deployed DBs pick up new nullable columns on startup without deleting data. For local throwaway DBs, deleting `data/cflist.sqlite` and restarting is still fine.
