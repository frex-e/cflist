/**
 * Populates the local SQLite DB by running syncUserStatus against a fake
 * Codeforces client — estimates are computed by the real sync/hydration path,
 * not inserted manually.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { migrate } from "../dist/src/db/migrate.js";
import { syncState, syncUserStatus } from "../dist/src/cf/sync.js";

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data/cflist.sqlite");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
migrate(db);

const contestId = 888001;
const handle = "inj";
const nowSeconds = Math.floor(Date.now() / 1000);
const start = nowSeconds - 20_000;
const duration = 7200;

const user = db.prepare(`SELECT id FROM "user" WHERE cfHandle = @handle`).get({ handle });
if (!user) {
  throw new Error(`No user with cfHandle=${handle}. Run npm run seed:test-user first.`);
}

// Remove previous demo contests so the page only shows sync-computed rows.
db.prepare("DELETE FROM contests WHERE id IN (999901, 888001)").run();

class SyncDemoClient {
  async contests() {
    return [{
      id: contestId,
      name: "Sync-Computed Estimate Round (Div. 2)",
      phase: "FINISHED",
      startTimeSeconds: start,
      durationSeconds: duration,
    }];
  }

  async problemset() {
    return {
      problems: [
        { contestId, index: "A", name: "Sync Easy", tags: ["implementation"] },
        { contestId, index: "B", name: "Sync Medium", tags: ["greedy"] },
        { contestId, index: "C", name: "Sync Hard", tags: ["dp"] },
      ],
      problemStatistics: [
        { contestId, index: "A", solvedCount: 50_000 },
        { contestId, index: "B", solvedCount: 20_000 },
        { contestId, index: "C", solvedCount: 1_000 },
      ],
    };
  }

  async userStatus() {
    return [{
      id: 1,
      contestId,
      creationTimeSeconds: start + 120,
      verdict: "OK",
      problem: { contestId, index: "A", name: "Sync Easy", tags: ["implementation"] },
    }];
  }

  async userRating() {
    return [{
      contestId,
      contestName: "Sync-Computed Estimate Round (Div. 2)",
      handle,
      rank: 1,
      ratingUpdateTimeSeconds: start + duration + 60,
      oldRating: 2000,
      newRating: 2050,
    }];
  }

  async contestRatingChanges() {
    return Array.from({ length: 10 }, (_, i) => ({
      contestId,
      contestName: "Sync-Computed Estimate Round (Div. 2)",
      handle: i === 0 ? handle : `user${i}`,
      rank: i + 1,
      ratingUpdateTimeSeconds: start + duration + 60,
      oldRating: 2000,
      newRating: 2000,
    }));
  }

  async contestStandings() {
    return {
      contest: {
        id: contestId,
        name: "Sync-Computed Estimate Round (Div. 2)",
        phase: "FINISHED",
        startTimeSeconds: start,
        durationSeconds: duration,
      },
      problems: [
        { contestId, index: "A", name: "Sync Easy", tags: ["implementation"] },
        { contestId, index: "B", name: "Sync Medium", tags: ["greedy"] },
        { contestId, index: "C", name: "Sync Hard", tags: ["dp"] },
      ],
      // 5 solve A, 3 solve B, 0 solve C among a flat 2000 field → ~2000 / ~1852 / 5000
      rows: Array.from({ length: 10 }, (_, i) => ({
        party: {
          members: [{ handle: i === 0 ? handle : `user${i}` }],
          participantType: "CONTESTANT",
        },
        rank: i + 1,
        points: (i < 5 ? 1 : 0) + (i < 3 ? 1 : 0),
        penalty: 0,
        problemResults: [
          i < 5 ? { points: 1, bestSubmissionTimeSeconds: 10 } : { points: 0 },
          i < 3 ? { points: 1, bestSubmissionTimeSeconds: 20 } : { points: 0 },
          { points: 0 },
        ],
      })),
    };
  }
}

syncState.catalogRunning = false;
syncState.userRunning.clear();
syncState.contestQueueRunning = false;

await syncUserStatus(db, user.id, handle, new SyncDemoClient());

const rows = db.prepare(`
  SELECT problem_index, name, rating, estimated_rating, solved_count
  FROM problems
  WHERE contest_id = @contestId
  ORDER BY problem_index
`).all({ contestId });

console.log(JSON.stringify({ contestId, via: "syncUserStatus", rows }, null, 2));
db.close();
