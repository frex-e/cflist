import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CfRatingChange } from "../src/cf/types.js";
import { backfillUserContestPerformances } from "../src/cf/sync/cache.js";
import { migrate } from "../src/db/migrate.js";

test("backfillUserContestPerformances restores performance from cached rating changes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  const userId = "user-1";
  const cfHandle = "inj";
  const contestId = 796;

  db.prepare(`
    INSERT INTO "user" (
      id, name, email, emailVerified, createdAt, updatedAt, cfHandle
    ) VALUES (
      @id, 'Test User', 'user@example.com', 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', @cfHandle
    )
  `).run({ id: userId, cfHandle });

  db.prepare(`
    INSERT INTO contests (id, name, start_time_seconds, duration_seconds, raw_json, updated_at)
    VALUES (@id, @name, @startTimeSeconds, 7200, '{}', '2026-01-01T00:00:00.000Z')
  `).run({ id: contestId, name: "Codeforces Round 796 (Div. 2)", startTimeSeconds: 1_000_000 });

  db.prepare(`
    INSERT INTO user_contest_results (
      user_id, contest_id, rank, old_rating, new_rating, rating_delta, performance, last_checked_at
    ) VALUES (
      @userId, @contestId, @rank, @oldRating, @newRating, @ratingDelta, NULL, '2026-01-01T00:00:00.000Z'
    )
  `).run({
    userId,
    contestId,
    rank: 102,
    oldRating: 0,
    newRating: 394,
    ratingDelta: 394,
  });

  const ratingChanges: CfRatingChange[] = [];
  for (let rank = 1; rank <= 150; rank += 1) {
    ratingChanges.push({
      contestId,
      contestName: "Codeforces Round 796 (Div. 2)",
      handle: rank === 102 ? cfHandle : `p${rank}`,
      rank,
      ratingUpdateTimeSeconds: 1,
      oldRating: rank === 102 ? 0 : 1000 + (rank % 1500),
      newRating: rank === 102 ? 394 : 1000 + (rank % 1500) + (rank % 2 === 0 ? 50 : -50),
    });
  }

  db.prepare(`
    INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
    VALUES (@contestId, @rawJson, '2026-01-01T00:00:00.000Z')
  `).run({ contestId, rawJson: JSON.stringify(ratingChanges) });

  backfillUserContestPerformances(db, userId);

  const row = db.prepare(`
    SELECT performance
    FROM user_contest_results
    WHERE user_id = @userId AND contest_id = @contestId
  `).get({ userId, contestId }) as { performance: number | null };

  assert.notEqual(row.performance, null);
  assert.ok(row.performance! < 1400);
});
