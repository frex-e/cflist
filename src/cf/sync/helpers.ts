import { transaction, type Db } from "../../db/connection.js";
import type { CfContest, CfRatingChange, CfSubmission } from "../types.js";

export const now = (): string => new Date().toISOString();

export const codeforcesProblemUrl = (contestId: number, problemIndex: string): string => {
  return `https://codeforces.com/contest/${contestId}/problem/${encodeURIComponent(problemIndex)}`;
};

export const hasHandle = (row: { party: { members: { handle: string }[] } }, handle: string): boolean => {
  return row.party.members.some((member) => member.handle.toLowerCase() === handle.toLowerCase());
};

export const inContest = (submission: CfSubmission, contest: CfContest): boolean => {
  if (contest.startTimeSeconds === undefined || contest.durationSeconds === undefined) return false;
  const endTime = contest.startTimeSeconds + contest.durationSeconds;
  return submission.creationTimeSeconds >= contest.startTimeSeconds && submission.creationTimeSeconds <= endTime;
};

export const contestSortValue = (
  contest: CfContest | undefined,
  ratingChange: { ratingUpdateTimeSeconds?: number } | undefined,
): number => {
  return contest?.startTimeSeconds ?? ratingChange?.ratingUpdateTimeSeconds ?? 0;
};

export const loadContestsById = (db: Db): Map<number, CfContest> => {
  const contestRows = db
    .prepare(
      `
      SELECT
        id,
        name,
        phase,
        start_time_seconds AS startTimeSeconds,
        duration_seconds AS durationSeconds
      FROM contests
    `,
    )
    .all() as unknown as CfContest[];
  return new Map(contestRows.map((contest) => [contest.id, contest]));
};

export const missingContestIds = (
  contestIds: Iterable<number>,
  contestsById: Map<number, CfContest>,
): number[] => [...new Set(contestIds)].filter((contestId) => !contestsById.has(contestId));

export const ensureContestsExist = (
  db: Db,
  contestIds: number[],
  ratingsByContestId: Map<number, CfRatingChange>,
  contestsById: Map<number, CfContest>,
  checkedAt: string,
): void => {
  const insertStub = db.prepare(`
    INSERT INTO contests (
      id,
      name,
      start_time_seconds,
      raw_json,
      updated_at
    ) VALUES (
      @id,
      @name,
      @startTimeSeconds,
      @rawJson,
      @updatedAt
    )
    ON CONFLICT(id) DO NOTHING
  `);

  transaction(db, () => {
    for (const contestId of contestIds) {
      if (contestsById.has(contestId)) continue;

      const rating = ratingsByContestId.get(contestId);
      const name = rating?.contestName ?? `Contest ${contestId}`;
      const stub: CfContest = {
        id: contestId,
        name,
        startTimeSeconds: rating?.ratingUpdateTimeSeconds,
      };

      insertStub.run({
        id: contestId,
        name,
        startTimeSeconds: stub.startTimeSeconds ?? null,
        rawJson: JSON.stringify(stub),
        updatedAt: checkedAt,
      });
      contestsById.set(contestId, stub);
    }
  });
};
