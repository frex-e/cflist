import { transaction, type Db } from "../db/connection.js";
import { CodeforcesClient } from "./client.js";
import { classifyContest } from "./classify.js";
import type { CfContest, CfProblem, CfSubmission } from "./types.js";

export type SyncState = {
  running: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
};

export const syncState: SyncState = {
  running: false,
};

type AcceptedProblem = {
  contestId: number;
  problemIndex: string;
  firstSubmissionId: number;
  firstAcceptedAtSeconds: number;
  acceptedCount: number;
};

const now = (): string => new Date().toISOString();

const problemKey = (contestId: number, problemIndex: string): string => `${contestId}:${problemIndex}`;

const codeforcesProblemUrl = (contestId: number, problemIndex: string): string => {
  return `https://codeforces.com/contest/${contestId}/problem/${encodeURIComponent(problemIndex)}`;
};

const isRegularOfficialProblem = (problem: CfProblem, contestsById: Map<number, CfContest>): problem is CfProblem & { contestId: number } => {
  if (typeof problem.contestId !== "number") return false;
  if (problem.problemsetName) return false;
  return contestsById.has(problem.contestId);
};

export const acceptedProblemsFromSubmissions = (
  submissions: CfSubmission[],
  contestsById: Map<number, CfContest>,
): Map<string, AcceptedProblem> => {
  const accepted = new Map<string, AcceptedProblem>();

  for (const submission of submissions) {
    if (submission.verdict !== "OK") continue;
    if (!isRegularOfficialProblem(submission.problem, contestsById)) continue;

    const contestId = submission.problem.contestId;
    const problemIndex = submission.problem.index;
    const key = problemKey(contestId, problemIndex);
    const existing = accepted.get(key);

    if (!existing) {
      accepted.set(key, {
        contestId,
        problemIndex,
        firstSubmissionId: submission.id,
        firstAcceptedAtSeconds: submission.creationTimeSeconds,
        acceptedCount: 1,
      });
      continue;
    }

    existing.acceptedCount += 1;
    if (submission.creationTimeSeconds < existing.firstAcceptedAtSeconds) {
      existing.firstAcceptedAtSeconds = submission.creationTimeSeconds;
      existing.firstSubmissionId = submission.id;
    }
  }

  return accepted;
};

export const syncCodeforces = async (
  db: Db,
  handle: string,
  client = new CodeforcesClient(),
): Promise<void> => {
  if (syncState.running) return;

  syncState.running = true;
  syncState.lastStartedAt = now();
  syncState.lastError = undefined;

  const syncRun = db
    .prepare(
      "INSERT INTO sync_runs (started_at, status, source) VALUES (@startedAt, 'running', 'codeforces')",
    )
    .run({ startedAt: syncState.lastStartedAt });
  const syncRunId = Number(syncRun.lastInsertRowid);

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

    const writeContests = () => transaction(db, () => {
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
    writeContests();

    const problemset = await client.problemset();
    const statsByKey = new Map(
      problemset.problemStatistics.map((stat) => [
        problemKey(stat.contestId, stat.index),
        stat.solvedCount,
      ]),
    );

    const upsertProblem = db.prepare(`
      INSERT INTO problems (
        contest_id,
        problemset_name,
        problem_index,
        name,
        type,
        points,
        rating,
        solved_count,
        tags_json,
        url,
        raw_json,
        updated_at
      ) VALUES (
        @contestId,
        @problemsetName,
        @problemIndex,
        @name,
        @type,
        @points,
        @rating,
        @solvedCount,
        @tagsJson,
        @url,
        @rawJson,
        @updatedAt
      )
      ON CONFLICT(contest_id, problem_index) DO UPDATE SET
        problemset_name = excluded.problemset_name,
        name = excluded.name,
        type = excluded.type,
        points = excluded.points,
        rating = excluded.rating,
        solved_count = excluded.solved_count,
        tags_json = excluded.tags_json,
        url = excluded.url,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);
    const deleteProblemTags = db.prepare(
      "DELETE FROM problem_tags WHERE contest_id = @contestId AND problem_index = @problemIndex",
    );
    const insertProblemTag = db.prepare(`
      INSERT OR IGNORE INTO problem_tags (contest_id, problem_index, tag)
      VALUES (@contestId, @problemIndex, @tag)
    `);

    const writeProblems = () => transaction(db, () => {
      for (const problem of problemset.problems) {
        if (!isRegularOfficialProblem(problem, contestsById)) continue;
        const contestId = problem.contestId;
        const problemIndex = problem.index;
        const tags = [...new Set(problem.tags)].sort((a, b) => a.localeCompare(b));

        upsertProblem.run({
          contestId,
          problemsetName: problem.problemsetName ?? null,
          problemIndex,
          name: problem.name,
          type: problem.type ?? null,
          points: problem.points ?? null,
          rating: problem.rating ?? null,
          solvedCount: statsByKey.get(problemKey(contestId, problemIndex)) ?? null,
          tagsJson: JSON.stringify(tags),
          url: codeforcesProblemUrl(contestId, problemIndex),
          rawJson: JSON.stringify(problem),
          updatedAt: fetchedAt,
        });

        deleteProblemTags.run({ contestId, problemIndex });
        for (const tag of tags) {
          insertProblemTag.run({ contestId, problemIndex, tag });
        }
      }
    });
    writeProblems();

    const submissions = await client.userStatus(handle);
    const accepted = acceptedProblemsFromSubmissions(submissions, contestsById);
    const checkedAt = now();

    const clearStatus = db.prepare("DELETE FROM user_problem_status WHERE handle = @handle");
    const insertStatus = db.prepare(`
      INSERT INTO user_problem_status (
        handle,
        contest_id,
        problem_index,
        solved,
        first_accepted_submission_id,
        first_accepted_at_seconds,
        accepted_count,
        last_checked_at
      ) VALUES (
        @handle,
        @contestId,
        @problemIndex,
        1,
        @firstSubmissionId,
        @firstAcceptedAtSeconds,
        @acceptedCount,
        @checkedAt
      )
    `);
    const writeStatus = () => transaction(db, () => {
      clearStatus.run({ handle });
      for (const item of accepted.values()) {
        insertStatus.run({
          handle,
          contestId: item.contestId,
          problemIndex: item.problemIndex,
          firstSubmissionId: item.firstSubmissionId,
          firstAcceptedAtSeconds: item.firstAcceptedAtSeconds,
          acceptedCount: item.acceptedCount,
          checkedAt,
        });
      }
    });
    writeStatus();

    syncState.lastFinishedAt = now();
    db.prepare(
      `
      UPDATE sync_runs
      SET status = 'success', finished_at = @finishedAt, message = @message
      WHERE id = @id
    `,
    ).run({
      id: syncRunId,
      finishedAt: syncState.lastFinishedAt,
      message: `Synced ${contests.length} contests, ${problemset.problems.length} API problems, ${accepted.size} solved problems for ${handle}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    syncState.lastFinishedAt = now();
    syncState.lastError = message;
    db.prepare(
      `
      UPDATE sync_runs
      SET status = 'failed', finished_at = @finishedAt, message = @message
      WHERE id = @id
    `,
    ).run({ id: syncRunId, finishedAt: syncState.lastFinishedAt, message });
    throw error;
  } finally {
    syncState.running = false;
  }
};
