import { transaction, type Db } from "../db/connection.js";
import { CodeforcesClient } from "./client.js";
import { classifyContest } from "./classify.js";
import { estimateContestPerformance } from "./rating.js";
import type { CfContest, CfProblem, CfRatingChange, CfStandings, CfStandingsRow, CfSubmission } from "./types.js";

export type SyncState = {
  catalogRunning: boolean;
  userRunning: Set<string>;
  contestQueueRunning: boolean;
  lastCatalogStartedAt?: string;
  lastCatalogFinishedAt?: string;
  lastCatalogError?: string;
};

export const syncState: SyncState = {
  catalogRunning: false,
  userRunning: new Set(),
  contestQueueRunning: false,
};

type AcceptedProblem = {
  contestId: number;
  problemIndex: string;
  firstSubmissionId: number;
  firstAcceptedAtSeconds: number;
  acceptedCount: number;
};

const MAX_CONTEST_RESULTS_ENQUEUE = 30;
const MAX_CONTEST_RESULTS_BACKFILL_ENQUEUE = 3;
const MAX_CONTEST_JOB_ATTEMPTS = 3;
const MAX_CONTEST_JOBS_PER_KICK = 3;
const STALE_CONTEST_JOB_MINUTES = 30;

type ContestProblemResult = {
  problemIndex: string;
  points: number | null;
  penalty: number | null;
  rejectedAttemptCount: number | null;
  bestSubmissionTimeSeconds: number | null;
  solvedInContest: 0 | 1;
  upsolved: 0 | 1;
};

type ContestJob = {
  id: number;
  user_id: string;
  cf_handle: string;
  contest_id: number;
  attempts: number;
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

const hasHandle = (row: CfStandingsRow, handle: string): boolean => {
  return row.party.members.some((member) => member.handle.toLowerCase() === handle.toLowerCase());
};

const contestEndTime = (contest: CfContest): number | undefined => {
  if (contest.startTimeSeconds === undefined || contest.durationSeconds === undefined) return undefined;
  return contest.startTimeSeconds + contest.durationSeconds;
};

const inContest = (submission: CfSubmission, contest: CfContest): boolean => {
  const endTime = contestEndTime(contest);
  if (contest.startTimeSeconds === undefined || endTime === undefined) return false;
  return submission.creationTimeSeconds >= contest.startTimeSeconds && submission.creationTimeSeconds <= endTime;
};

const contestSortValue = (contest: CfContest | undefined, ratingChange: CfRatingChange | undefined): number => {
  return contest?.startTimeSeconds ?? ratingChange?.ratingUpdateTimeSeconds ?? 0;
};

const handleKey = (handle: string): string => handle.toLowerCase();

const parseCachedJson = <T>(value: string | undefined): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const getCachedStandings = (db: Db, contestId: number): CfStandings | undefined => {
  const cached = db
    .prepare("SELECT raw_json FROM contest_standings_cache WHERE contest_id = @contestId")
    .get({ contestId }) as { raw_json: string } | undefined;
  return parseCachedJson<CfStandings>(cached?.raw_json);
};

const getOrFetchRatingChanges = async (
  db: Db,
  client: CodeforcesClient,
  contestId: number,
): Promise<CfRatingChange[]> => {
  const cached = db
    .prepare("SELECT raw_json FROM contest_rating_changes_cache WHERE contest_id = @contestId")
    .get({ contestId }) as { raw_json: string } | undefined;
  const cachedChanges = parseCachedJson<CfRatingChange[]>(cached?.raw_json);
  if (cachedChanges) return cachedChanges;

  const changes = await client.contestRatingChanges(contestId);
  db.prepare(
    `
    INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
    VALUES (@contestId, @rawJson, @fetchedAt)
    ON CONFLICT(contest_id) DO UPDATE SET
      raw_json = excluded.raw_json,
      fetched_at = excluded.fetched_at
  `,
  ).run({ contestId, rawJson: JSON.stringify(changes), fetchedAt: now() });
  return changes;
};

const getOrFetchStandings = async (
  db: Db,
  client: CodeforcesClient,
  contestId: number,
): Promise<CfStandings> => {
  const cachedStandings = getCachedStandings(db, contestId);
  if (cachedStandings) return cachedStandings;

  const standings = await client.contestStandings(contestId);
  db.prepare(
    `
    INSERT INTO contest_standings_cache (contest_id, raw_json, fetched_at)
    VALUES (@contestId, @rawJson, @fetchedAt)
    ON CONFLICT(contest_id) DO UPDATE SET
      raw_json = excluded.raw_json,
      fetched_at = excluded.fetched_at
  `,
  ).run({ contestId, rawJson: JSON.stringify(standings), fetchedAt: now() });
  return standings;
};

const getOrCalculatePerformance = async (
  db: Db,
  client: CodeforcesClient,
  contestId: number,
  handle: string,
): Promise<number | null> => {
  const key = handleKey(handle);
  const cached = db
    .prepare(
      `
      SELECT performance
      FROM contest_performance_cache
      WHERE contest_id = @contestId AND handle_key = @handleKey
    `,
    )
    .get({ contestId, handleKey: key }) as { performance: number | null } | undefined;
  if (cached) return cached.performance;

  const changes = await getOrFetchRatingChanges(db, client, contestId);
  const performance = estimateContestPerformance(changes, handle)?.performance ?? null;
  db.prepare(
    `
    INSERT INTO contest_performance_cache (
      contest_id,
      handle_key,
      handle,
      performance,
      calculated_at
    ) VALUES (
      @contestId,
      @handleKey,
      @handle,
      @performance,
      @calculatedAt
    )
    ON CONFLICT(contest_id, handle_key) DO UPDATE SET
      handle = excluded.handle,
      performance = excluded.performance,
      calculated_at = excluded.calculated_at
  `,
  ).run({
    contestId,
    handleKey: key,
    handle,
    performance,
    calculatedAt: now(),
  });
  return performance;
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

const loadContestsById = (db: Db): Map<number, CfContest> => {
  const contestRows = db
    .prepare("SELECT id, name, start_time_seconds AS startTimeSeconds, duration_seconds AS durationSeconds FROM contests")
    .all() as unknown as CfContest[];
  return new Map(contestRows.map((contest) => [contest.id, contest]));
};

const acceptedProblemsFromDb = (db: Db, userId: string): Map<string, AcceptedProblem> => {
  const rows = db
    .prepare(
      `
      SELECT contest_id, problem_index, first_accepted_submission_id, first_accepted_at_seconds, accepted_count
      FROM user_problem_status
      WHERE user_id = @userId AND solved = 1
    `,
    )
    .all({ userId }) as {
      contest_id: number;
      problem_index: string;
      first_accepted_submission_id: number;
      first_accepted_at_seconds: number;
      accepted_count: number;
    }[];

  return new Map(
    rows.map((row) => [
      problemKey(row.contest_id, row.problem_index),
      {
        contestId: row.contest_id,
        problemIndex: row.problem_index,
        firstSubmissionId: row.first_accepted_submission_id,
        firstAcceptedAtSeconds: row.first_accepted_at_seconds,
        acceptedCount: row.accepted_count,
      },
    ]),
  );
};

const recomputeExistingUpsolves = (
  db: Db,
  userId: string,
  contestId: number,
  contest: CfContest | undefined,
  accepted: Map<string, AcceptedProblem>,
): void => {
  const endTime = contest ? contestEndTime(contest) : undefined;
  const rows = db
    .prepare(
      `
      SELECT problem_index, solved_in_contest
      FROM user_contest_problem_results
      WHERE user_id = @userId AND contest_id = @contestId
    `,
    )
    .all({ userId, contestId }) as {
      problem_index: string;
      solved_in_contest: number;
    }[];
  const update = db.prepare(`
    UPDATE user_contest_problem_results
    SET upsolved = @upsolved
    WHERE user_id = @userId
      AND contest_id = @contestId
      AND problem_index = @problemIndex
  `);

  for (const row of rows) {
    const firstAccepted = accepted.get(problemKey(contestId, row.problem_index));
    const upsolved =
      row.solved_in_contest !== 1
      && firstAccepted !== undefined
      && (endTime === undefined || firstAccepted.firstAcceptedAtSeconds > endTime);
    update.run({
      userId,
      contestId,
      problemIndex: row.problem_index,
      upsolved: upsolved ? 1 : 0,
    });
  }
};

const writeBasicContestResults = (
  db: Db,
  userId: string,
  cfHandle: string,
  contestIds: number[],
  ratingsByContestId: Map<number, CfRatingChange>,
  checkedAt: string,
): void => {
  const upsert = db.prepare(`
    INSERT INTO user_contest_results (
      user_id,
      cf_handle,
      contest_id,
      rank,
      points,
      penalty,
      participant_type,
      old_rating,
      new_rating,
      rating_delta,
      performance,
      last_checked_at
    ) VALUES (
      @userId,
      @cfHandle,
      @contestId,
      @rank,
      NULL,
      NULL,
      NULL,
      @oldRating,
      @newRating,
      @ratingDelta,
      NULL,
      @checkedAt
    )
    ON CONFLICT(user_id, contest_id) DO UPDATE SET
      cf_handle = excluded.cf_handle,
      rank = COALESCE(excluded.rank, user_contest_results.rank),
      old_rating = COALESCE(excluded.old_rating, user_contest_results.old_rating),
      new_rating = COALESCE(excluded.new_rating, user_contest_results.new_rating),
      rating_delta = COALESCE(excluded.rating_delta, user_contest_results.rating_delta),
      last_checked_at = excluded.last_checked_at
  `);

  transaction(db, () => {
    for (const contestId of contestIds) {
      const ratingChange = ratingsByContestId.get(contestId);
      upsert.run({
        userId,
        cfHandle,
        contestId,
        rank: ratingChange?.rank ?? null,
        oldRating: ratingChange?.oldRating ?? null,
        newRating: ratingChange?.newRating ?? null,
        ratingDelta: ratingChange ? ratingChange.newRating - ratingChange.oldRating : null,
        checkedAt,
      });
    }
  });
};

const completedContestProblemCounts = (db: Db, userId: string): Map<number, number> => {
  const rows = db.prepare(`
    SELECT
      ucr.contest_id,
      COUNT(ucpr.problem_index) AS problem_count
    FROM user_contest_results ucr
    LEFT JOIN user_contest_problem_results ucpr
      ON ucpr.user_id = ucr.user_id
      AND ucpr.contest_id = ucr.contest_id
    WHERE ucr.user_id = @userId
    GROUP BY ucr.contest_id
  `).all({ userId }) as { contest_id: number; problem_count: number }[];

  return new Map(rows.map((row) => [row.contest_id, row.problem_count]));
};

const enqueueContestHydrationJobs = (
  db: Db,
  userId: string,
  cfHandle: string,
  contestIds: number[],
  priorityOffset: number,
): number => {
  const timestamp = now();
  const upsert = db.prepare(`
    INSERT INTO contest_sync_jobs (
      user_id,
      cf_handle,
      contest_id,
      priority,
      status,
      attempts,
      available_at,
      created_at,
      updated_at
    ) VALUES (
      @userId,
      @cfHandle,
      @contestId,
      @priority,
      'queued',
      0,
      @availableAt,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT(user_id, contest_id) DO UPDATE SET
      cf_handle = excluded.cf_handle,
      priority = MIN(contest_sync_jobs.priority, excluded.priority),
      status = CASE
        WHEN contest_sync_jobs.status = 'running' THEN contest_sync_jobs.status
        ELSE 'queued'
      END,
      attempts = CASE
        WHEN contest_sync_jobs.status = 'running' THEN contest_sync_jobs.attempts
        ELSE 0
      END,
      available_at = excluded.available_at,
      updated_at = excluded.updated_at,
      last_error = CASE
        WHEN contest_sync_jobs.status = 'running' THEN contest_sync_jobs.last_error
        ELSE NULL
      END
    WHERE contest_sync_jobs.status != 'done'
  `);

  let changedRows = 0;
  transaction(db, () => {
    contestIds.forEach((contestId, index) => {
      const result = upsert.run({
        userId,
        cfHandle,
        contestId,
        priority: priorityOffset + index,
        availableAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      changedRows += Number(result.changes);
    });
  });

  return changedRows;
};

const claimContestJob = (db: Db): ContestJob | undefined => {
  const timestamp = now();
  const job = db
    .prepare(
      `
      SELECT id, user_id, cf_handle, contest_id, attempts
      FROM contest_sync_jobs
      WHERE status IN ('queued', 'failed')
        AND attempts < @maxAttempts
        AND available_at <= @timestamp
      ORDER BY priority ASC, id ASC
      LIMIT 1
    `,
    )
    .get({ maxAttempts: MAX_CONTEST_JOB_ATTEMPTS, timestamp }) as ContestJob | undefined;
  if (!job) return undefined;

  db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'running',
      attempts = attempts + 1,
      started_at = @startedAt,
      updated_at = @startedAt
    WHERE id = @id
  `,
  ).run({ id: job.id, startedAt: timestamp });

  return { ...job, attempts: job.attempts + 1 };
};

const resetStaleContestJobs = (db: Db): void => {
  const timestamp = now();
  const staleBefore = new Date(Date.now() - STALE_CONTEST_JOB_MINUTES * 60 * 1000).toISOString();
  db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'queued',
      available_at = @timestamp,
      updated_at = @timestamp,
      last_error = 'Reset stale running contest sync job after process restart'
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND started_at <= @staleBefore
  `,
  ).run({ timestamp, staleBefore });
};

const finishContestJob = (db: Db, id: number): void => {
  const timestamp = now();
  db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'done',
      finished_at = @finishedAt,
      updated_at = @finishedAt,
      last_error = NULL
    WHERE id = @id
  `,
  ).run({ id, finishedAt: timestamp });
};

const failContestJob = (db: Db, job: ContestJob, error: unknown): void => {
  const timestamp = now();
  const delayMinutes = Math.min(60, Math.max(1, job.attempts) * 5);
  const availableAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'failed',
      available_at = @availableAt,
      finished_at = @finishedAt,
      updated_at = @finishedAt,
      last_error = @message
    WHERE id = @id
  `,
  ).run({ id: job.id, availableAt, finishedAt: timestamp, message });
};

export const syncCatalog = async (
  db: Db,
  client = new CodeforcesClient(),
): Promise<void> => {
  if (syncState.catalogRunning) return;

  syncState.catalogRunning = true;
  syncState.lastCatalogStartedAt = now();
  syncState.lastCatalogError = undefined;

  const syncRun = db
    .prepare(
      "INSERT INTO sync_runs (started_at, status, source) VALUES (@startedAt, 'running', 'codeforces:catalog')",
    )
    .run({ startedAt: syncState.lastCatalogStartedAt });
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

    syncState.lastCatalogFinishedAt = now();
    db.prepare(
      `
      UPDATE sync_runs
      SET status = 'success', finished_at = @finishedAt, message = @message
      WHERE id = @id
    `,
    ).run({
      id: syncRunId,
      finishedAt: syncState.lastCatalogFinishedAt,
      message: `Synced ${contests.length} contests and ${problemset.problems.length} API problems.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    syncState.lastCatalogFinishedAt = now();
    syncState.lastCatalogError = message;
    db.prepare(
      `
      UPDATE sync_runs
      SET status = 'failed', finished_at = @finishedAt, message = @message
      WHERE id = @id
    `,
    ).run({ id: syncRunId, finishedAt: syncState.lastCatalogFinishedAt, message });
    throw error;
  } finally {
    syncState.catalogRunning = false;
  }
};

export const hydrateUserContestResult = async (
  db: Db,
  userId: string,
  cfHandle: string,
  contestId: number,
  client = new CodeforcesClient(),
): Promise<void> => {
  const contestsById = loadContestsById(db);
  const accepted = acceptedProblemsFromDb(db, userId);
  const checkedAt = now();

  const existing = db
    .prepare(
      `
      SELECT
        rank,
        old_rating,
        new_rating,
        rating_delta,
        performance,
        (
          SELECT COUNT(*)
          FROM user_contest_problem_results ucpr
          WHERE ucpr.user_id = ucr.user_id
            AND ucpr.contest_id = ucr.contest_id
        ) AS problem_count
      FROM user_contest_results ucr
      WHERE user_id = @userId AND contest_id = @contestId
    `,
    )
    .get({ userId, contestId }) as {
      rank: number | null;
      old_rating: number | null;
      new_rating: number | null;
      rating_delta: number | null;
      performance: number | null;
      problem_count: number;
    } | undefined;

  if (existing && existing.problem_count > 0) {
    const cachedStandings = getCachedStandings(db, contestId);
    const standingsProblemCount = cachedStandings?.problems.length ?? 0;
    if (!cachedStandings || existing.problem_count >= standingsProblemCount) {
      const needsPerformance = existing.old_rating !== null && existing.new_rating !== null && existing.performance === null && existing.rank !== 1;
      const performance = needsPerformance
        ? await getOrCalculatePerformance(db, client, contestId, cfHandle)
        : existing.performance;
      db.prepare(
        `
        UPDATE user_contest_results
        SET
          cf_handle = @cfHandle,
          performance = @performance,
          last_checked_at = @checkedAt
        WHERE user_id = @userId AND contest_id = @contestId
      `,
      ).run({
        userId,
        cfHandle,
        contestId,
        performance,
        checkedAt,
      });
      recomputeExistingUpsolves(db, userId, contestId, contestsById.get(contestId), accepted);
      return;
    }
  }

  const existingRatingChange = existing && existing.old_rating !== null && existing.new_rating !== null
    ? {
        rank: existing.rank,
        oldRating: existing.old_rating,
        newRating: existing.new_rating,
      }
    : undefined;
  const performance = existingRatingChange && existingRatingChange.rank !== 1
    ? await getOrCalculatePerformance(db, client, contestId, cfHandle)
    : null;
  const standings = await getOrFetchStandings(db, client, contestId);
  const knownProblemRows = db
    .prepare(
      `
      SELECT contest_id, problem_index
      FROM problems
      WHERE contest_id = @contestId
    `,
    )
    .all({ contestId }) as { contest_id: number; problem_index: string }[];
  const knownProblems = new Set(knownProblemRows.map((row) => problemKey(row.contest_id, row.problem_index)));

  const upsertStandingsProblem = db.prepare(`
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
      NULL,
      @problemIndex,
      @name,
      @type,
      @points,
      @rating,
      NULL,
      @tagsJson,
      @url,
      @rawJson,
      @updatedAt
    )
    ON CONFLICT(contest_id, problem_index) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      points = excluded.points,
      rating = excluded.rating,
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

  transaction(db, () => {
    for (const problem of standings.problems) {
      if (!isRegularOfficialProblem(problem, contestsById)) continue;
      if (problem.contestId !== contestId) continue;

      const tags = [...new Set(problem.tags)].sort((a, b) => a.localeCompare(b));
      upsertStandingsProblem.run({
        contestId,
        problemIndex: problem.index,
        name: problem.name,
        type: problem.type ?? null,
        points: problem.points ?? null,
        rating: problem.rating ?? null,
        tagsJson: JSON.stringify(tags),
        url: codeforcesProblemUrl(contestId, problem.index),
        rawJson: JSON.stringify(problem),
        updatedAt: checkedAt,
      });
      deleteProblemTags.run({ contestId, problemIndex: problem.index });
      for (const tag of tags) {
        insertProblemTag.run({ contestId, problemIndex: problem.index, tag });
      }
      knownProblems.add(problemKey(contestId, problem.index));
    }
  });

  const row = standings.rows.find((standingsRow) => hasHandle(standingsRow, cfHandle));

  const contest = contestsById.get(contestId);
  const endTime = contest ? contestEndTime(contest) : undefined;
  const problemResults = standings.problems
    .map((problem, index): ContestProblemResult | undefined => {
      if (!knownProblems.has(problemKey(contestId, problem.index))) return undefined;

      const result = row?.problemResults[index];
      const firstAccepted = accepted.get(problemKey(contestId, problem.index));
      const acceptedDuringContest =
        firstAccepted !== undefined
        && contest?.startTimeSeconds !== undefined
        && endTime !== undefined
        && firstAccepted.firstAcceptedAtSeconds >= contest.startTimeSeconds
        && firstAccepted.firstAcceptedAtSeconds <= endTime;
      const solvedInContest = result?.bestSubmissionTimeSeconds !== undefined && result.points > 0;
      const fallbackBestSubmissionTime = acceptedDuringContest && contest?.startTimeSeconds !== undefined
        ? firstAccepted.firstAcceptedAtSeconds - contest.startTimeSeconds
        : null;
      const acceptedAfterContest =
        firstAccepted !== undefined
        && !solvedInContest
        && (endTime === undefined || firstAccepted.firstAcceptedAtSeconds > endTime);

      return {
        problemIndex: problem.index,
        points: result?.points ?? null,
        penalty: result?.penalty ?? null,
        rejectedAttemptCount: result?.rejectedAttemptCount ?? null,
        bestSubmissionTimeSeconds: result?.bestSubmissionTimeSeconds ?? fallbackBestSubmissionTime,
        solvedInContest: solvedInContest || acceptedDuringContest ? 1 as const : 0 as const,
        upsolved: acceptedAfterContest ? 1 as const : 0 as const,
      };
    })
    .filter((problem): problem is ContestProblemResult => problem !== undefined);

  if (!row && !existingRatingChange && problemResults.every((problem) => !problem.solvedInContest && !problem.upsolved)) {
    return;
  }

  const upsertContestResult = db.prepare(`
    INSERT INTO user_contest_results (
      user_id,
      cf_handle,
      contest_id,
      rank,
      points,
      penalty,
      participant_type,
      old_rating,
      new_rating,
      rating_delta,
      performance,
      last_checked_at
    ) VALUES (
      @userId,
      @cfHandle,
      @contestId,
      @rank,
      @points,
      @penalty,
      @participantType,
      @oldRating,
      @newRating,
      @ratingDelta,
      @performance,
      @checkedAt
    )
    ON CONFLICT(user_id, contest_id) DO UPDATE SET
      cf_handle = excluded.cf_handle,
      rank = excluded.rank,
      points = excluded.points,
      penalty = excluded.penalty,
      participant_type = excluded.participant_type,
      old_rating = excluded.old_rating,
      new_rating = excluded.new_rating,
      rating_delta = excluded.rating_delta,
      performance = excluded.performance,
      last_checked_at = excluded.last_checked_at
  `);
  const deleteContestProblemResults = db.prepare(`
    DELETE FROM user_contest_problem_results
    WHERE user_id = @userId AND contest_id = @contestId
  `);
  const upsertContestProblemResult = db.prepare(`
    INSERT INTO user_contest_problem_results (
      user_id,
      contest_id,
      problem_index,
      points,
      penalty,
      rejected_attempt_count,
      best_submission_time_seconds,
      solved_in_contest,
      upsolved
    ) VALUES (
      @userId,
      @contestId,
      @problemIndex,
      @points,
      @penalty,
      @rejectedAttemptCount,
      @bestSubmissionTimeSeconds,
      @solvedInContest,
      @upsolved
    )
    ON CONFLICT(user_id, contest_id, problem_index) DO UPDATE SET
      points = excluded.points,
      penalty = excluded.penalty,
      rejected_attempt_count = excluded.rejected_attempt_count,
      best_submission_time_seconds = excluded.best_submission_time_seconds,
      solved_in_contest = excluded.solved_in_contest,
      upsolved = excluded.upsolved
  `);

  transaction(db, () => {
    upsertContestResult.run({
      userId,
      cfHandle,
      contestId,
      rank: row?.rank ?? existingRatingChange?.rank ?? null,
      points: row?.points ?? null,
      penalty: row?.penalty ?? null,
      participantType: row?.party.participantType ?? null,
      oldRating: existingRatingChange?.oldRating ?? null,
      newRating: existingRatingChange?.newRating ?? null,
      ratingDelta: existingRatingChange ? existingRatingChange.newRating - existingRatingChange.oldRating : null,
      performance,
      checkedAt,
    });
    deleteContestProblemResults.run({ userId, contestId });
    for (const problem of problemResults) {
      upsertContestProblemResult.run({
        userId,
        contestId,
        problemIndex: problem.problemIndex,
        points: problem.points,
        penalty: problem.penalty,
        rejectedAttemptCount: problem.rejectedAttemptCount,
        bestSubmissionTimeSeconds: problem.bestSubmissionTimeSeconds,
        solvedInContest: problem.solvedInContest,
        upsolved: problem.upsolved,
      });
    }
  });
};

export const runContestSyncQueue = async (
  db: Db,
  client = new CodeforcesClient(),
  options: { maxJobs?: number } = {},
): Promise<number> => {
  if (syncState.contestQueueRunning) return 0;

  syncState.contestQueueRunning = true;
  let processed = 0;
  try {
    resetStaleContestJobs(db);
    while (options.maxJobs === undefined || processed < options.maxJobs) {
      const job = claimContestJob(db);
      if (!job) break;

      try {
        await hydrateUserContestResult(db, job.user_id, job.cf_handle, job.contest_id, client);
        finishContestJob(db, job.id);
      } catch (error) {
        failContestJob(db, job, error);
        console.error(`Contest sync job ${job.id} failed:`, error);
      }
      processed += 1;
    }
  } finally {
    syncState.contestQueueRunning = false;
  }

  return processed;
};

export const kickContestSyncQueue = (db: Db, client = new CodeforcesClient()): void => {
  void runContestSyncQueue(db, client, { maxJobs: MAX_CONTEST_JOBS_PER_KICK }).catch((error) => {
    console.error("Contest sync queue failed:", error);
  });
};

export const syncUserStatus = async (
  db: Db,
  userId: string,
  cfHandle: string,
  client = new CodeforcesClient(),
): Promise<void> => {
  if (syncState.userRunning.has(userId)) return;

  syncState.userRunning.add(userId);
  const startedAt = now();
  const syncRun = db
    .prepare(
      `
      INSERT INTO sync_runs (started_at, status, source, user_id, cf_handle)
      VALUES (@startedAt, 'running', 'codeforces:user', @userId, @cfHandle)
    `,
    )
    .run({ startedAt, userId, cfHandle });
  const syncRunId = Number(syncRun.lastInsertRowid);

  try {
    await syncCatalog(db, client);

    const contestsById = loadContestsById(db);
    const submissions = await client.userStatus(cfHandle);
    const accepted = acceptedProblemsFromSubmissions(submissions, contestsById);
    const ratingHistory = await client.userRating(cfHandle);
    const ratingsByContestId = new Map(ratingHistory.map((change) => [change.contestId, change]));
    const candidateContestIds = new Set(ratingHistory.map((change) => change.contestId));

    for (const submission of submissions) {
      if (typeof submission.contestId !== "number") continue;
      const contest = contestsById.get(submission.contestId);
      if (!contest || !inContest(submission, contest)) continue;
      candidateContestIds.add(submission.contestId);
    }

    const sortedCandidateContestIds = [...candidateContestIds]
      .sort((a, b) => contestSortValue(contestsById.get(b), ratingsByContestId.get(b)) - contestSortValue(contestsById.get(a), ratingsByContestId.get(a)));
    const problemCountsByContestId = completedContestProblemCounts(db, userId);
    const completedContestIds = new Set(
      [...problemCountsByContestId.entries()]
        .filter(([, problemCount]) => problemCount > 0)
        .map(([contestId]) => contestId),
    );
    const recentContestIds = sortedCandidateContestIds.slice(0, MAX_CONTEST_RESULTS_ENQUEUE);
    const recentContestIdSet = new Set(recentContestIds);
    const backfillContestIds = sortedCandidateContestIds
      .slice(MAX_CONTEST_RESULTS_ENQUEUE)
      .filter((contestId) => !recentContestIdSet.has(contestId) && !completedContestIds.has(contestId))
      .slice(0, MAX_CONTEST_RESULTS_BACKFILL_ENQUEUE);
    const checkedAt = now();

    const clearStatus = db.prepare("DELETE FROM user_problem_status WHERE user_id = @userId");
    const insertStatus = db.prepare(`
      INSERT INTO user_problem_status (
        user_id,
        cf_handle,
        contest_id,
        problem_index,
        solved,
        first_accepted_submission_id,
        first_accepted_at_seconds,
        accepted_count,
        last_checked_at
      ) VALUES (
        @userId,
        @cfHandle,
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
      clearStatus.run({ userId });
      for (const item of accepted.values()) {
        insertStatus.run({
          userId,
          cfHandle,
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

    writeBasicContestResults(db, userId, cfHandle, sortedCandidateContestIds, ratingsByContestId, checkedAt);

    for (const contestId of completedContestIds) {
      recomputeExistingUpsolves(db, userId, contestId, contestsById.get(contestId), accepted);
    }

    const hydrateRecentContestIds = recentContestIds.filter((contestId) => {
      const problemCount = problemCountsByContestId.get(contestId) ?? 0;
      if (problemCount === 0) return true;
      const cachedStandings = getCachedStandings(db, contestId);
      return cachedStandings !== undefined && problemCount < cachedStandings.problems.length;
    });
    const enqueuedRecent = enqueueContestHydrationJobs(db, userId, cfHandle, hydrateRecentContestIds, 0);
    const enqueuedBackfill = enqueueContestHydrationJobs(db, userId, cfHandle, backfillContestIds, 1000);
    const enqueuedContestResults = enqueuedRecent + enqueuedBackfill;

    const finishedAt = now();
    db.prepare(
      `
      UPDATE sync_runs
      SET status = 'success', finished_at = @finishedAt, message = @message
      WHERE id = @id
    `,
    ).run({
      id: syncRunId,
      finishedAt,
      message: `Synced ${accepted.size} solved problems and queued ${enqueuedContestResults} contest detail refreshes for ${cfHandle}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(
      `
      UPDATE sync_runs
      SET status = 'failed', finished_at = @finishedAt, message = @message
      WHERE id = @id
    `,
    ).run({ id: syncRunId, finishedAt: now(), message });
    throw error;
  } finally {
    syncState.userRunning.delete(userId);
  }
};
