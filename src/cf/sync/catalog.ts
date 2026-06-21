import { transaction, type Db } from "../../db/connection.js";
import { listProblemsNeedingMetadata } from "../../db/queries/catalog-sync.js";
import { finishSyncRun, startSyncRun } from "../../db/writes/sync-runs.js";
import { upsertProblemWithTags } from "../../db/writes/problems.js";
import {
  isRegularOfficialProblem,
  problemKey,
} from "../accepted-problems.js";
import { classifyContest } from "../classify.js";
import { CodeforcesClient } from "../client.js";
import type { CfProblem } from "../types.js";
import { getCodeforcesClient } from "../shared-client.js";
import { codeforcesProblemUrl, now } from "./helpers.js";
import { syncState } from "./state.js";

const hasProblemMetadata = (problem: CfProblem): boolean =>
  problem.rating != null || problem.tags.length > 0;

const runCatalogSync = async (db: Db, client: CodeforcesClient): Promise<void> => {
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

export const syncCatalog = async (
  db: Db,
  client: CodeforcesClient = getCodeforcesClient(),
): Promise<void> => {
  if (syncState.catalogSyncPromise) {
    return syncState.catalogSyncPromise;
  }

  syncState.catalogSyncPromise = runCatalogSync(db, client);
  try {
    await syncState.catalogSyncPromise;
  } finally {
    syncState.catalogSyncPromise = null;
  }
};

const runProblemMetadataRefresh = async (db: Db, client: CodeforcesClient): Promise<void> => {
  const needing = listProblemsNeedingMetadata(db);
  if (needing.length === 0) return;

  syncState.catalogRunning = true;
  syncState.lastCatalogStartedAt = now();
  syncState.lastCatalogError = undefined;

  const syncRunId = startSyncRun(db, "codeforces:catalog-metadata", syncState.lastCatalogStartedAt);

  try {
    const problemset = await client.problemset();
    const problemsByKey = new Map(
      problemset.problems
        .filter((problem): problem is CfProblem & { contestId: number } => typeof problem.contestId === "number")
        .map((problem) => [problemKey(problem.contestId, problem.index), problem]),
    );
    const statsByKey = new Map(
      problemset.problemStatistics.map((stat) => [
        problemKey(stat.contestId, stat.index),
        stat.solvedCount,
      ]),
    );
    const fetchedAt = now();
    let updatedCount = 0;

    transaction(db, () => {
      for (const { contestId, problemIndex } of needing) {
        const problem = problemsByKey.get(problemKey(contestId, problemIndex));
        if (!problem || !hasProblemMetadata(problem)) continue;

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
        updatedCount += 1;
      }
    });

    syncState.lastCatalogFinishedAt = now();
    finishSyncRun(
      db,
      syncRunId,
      "success",
      `Checked ${needing.length} problems needing metadata; updated ${updatedCount}.`,
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

export const refreshProblemMetadata = async (
  db: Db,
  client: CodeforcesClient = getCodeforcesClient(),
): Promise<void> => {
  if (syncState.catalogSyncPromise) return;
  if (syncState.metadataRefreshPromise) return syncState.metadataRefreshPromise;

  syncState.metadataRefreshPromise = runProblemMetadataRefresh(db, client);
  try {
    await syncState.metadataRefreshPromise;
  } finally {
    syncState.metadataRefreshPromise = null;
  }
};
