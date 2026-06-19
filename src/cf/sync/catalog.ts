import { transaction, type Db } from "../../db/connection.js";
import { finishSyncRun, startSyncRun } from "../../db/writes/sync-runs.js";
import { upsertProblemWithTags } from "../../db/writes/problems.js";
import {
  isRegularOfficialProblem,
  problemKey,
} from "../accepted-problems.js";
import { classifyContest } from "../classify.js";
import { CodeforcesClient } from "../client.js";
import { codeforcesProblemUrl, now } from "./helpers.js";
import { syncState } from "./state.js";

export const syncCatalog = async (
  db: Db,
  client = new CodeforcesClient(),
): Promise<void> => {
  if (syncState.catalogRunning) return;

  syncState.catalogRunning = true;
  syncState.lastCatalogStartedAt = now();
  syncState.lastCatalogError = undefined;

  const syncRunId = startSyncRun(db, "codeforces:catalog", syncState.lastCatalogStartedAt);

  try {
    const contests = await client.contests();
    const contestsById = new Map(contests.map((contest) => [contest.id, contest]));
    const fetchedAt = now();

    const upsertContest = db.prepare(`
      INSERT INTO contests (
        id,
        name,
        type,
        phase,
        duration_seconds,
        start_time_seconds,
        year,
        derived_family,
        derived_division,
        derived_label,
        raw_json,
        updated_at
      ) VALUES (
        @id,
        @name,
        @type,
        @phase,
        @durationSeconds,
        @startTimeSeconds,
        @year,
        @derivedFamily,
        @derivedDivision,
        @derivedLabel,
        @rawJson,
        @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        phase = excluded.phase,
        duration_seconds = excluded.duration_seconds,
        start_time_seconds = excluded.start_time_seconds,
        year = excluded.year,
        derived_family = excluded.derived_family,
        derived_division = excluded.derived_division,
        derived_label = excluded.derived_label,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);

    transaction(db, () => {
      for (const contest of contests) {
        const classification = classifyContest(contest);
        upsertContest.run({
          id: contest.id,
          name: contest.name,
          type: contest.type ?? null,
          phase: contest.phase ?? null,
          durationSeconds: contest.durationSeconds ?? null,
          startTimeSeconds: contest.startTimeSeconds ?? null,
          year: classification.year,
          derivedFamily: classification.family,
          derivedDivision: classification.division,
          derivedLabel: classification.label,
          rawJson: JSON.stringify(contest),
          updatedAt: fetchedAt,
        });
      }
    });

    const problemset = await client.problemset();
    const statsByKey = new Map(
      problemset.problemStatistics.map((stat) => [
        problemKey(stat.contestId, stat.index),
        stat.solvedCount,
      ]),
    );

    transaction(db, () => {
      for (const problem of problemset.problems) {
        if (!isRegularOfficialProblem(problem, contestsById)) continue;
        const contestId = problem.contestId;
        const problemIndex = problem.index;

        upsertProblemWithTags(db, {
          contestId,
          problemIndex,
          name: problem.name,
          type: problem.type ?? null,
          points: problem.points ?? null,
          rating: problem.rating ?? null,
          tags: problem.tags,
          url: codeforcesProblemUrl(contestId, problemIndex),
          rawJson: JSON.stringify(problem),
          updatedAt: fetchedAt,
          problemsetName: problem.problemsetName ?? null,
          solvedCount: statsByKey.get(problemKey(contestId, problemIndex)) ?? null,
        }, "catalog");
      }
    });

    syncState.lastCatalogFinishedAt = now();
    finishSyncRun(
      db,
      syncRunId,
      "success",
      `Synced ${contests.length} contests and ${problemset.problems.length} API problems.`,
      syncState.lastCatalogFinishedAt,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    syncState.lastCatalogFinishedAt = now();
    syncState.lastCatalogError = message;
    finishSyncRun(db, syncRunId, "failed", message, syncState.lastCatalogFinishedAt);
    throw error;
  } finally {
    syncState.catalogRunning = false;
  }
};
