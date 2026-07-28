import type { Db } from "../db/connection.js";
import type { CfContest, CfProblem, CfSubmission } from "./types.js";

export type AcceptedProblem = {
  contestId: number;
  problemIndex: string;
  firstSubmissionId: number;
  firstAcceptedAtSeconds: number;
  acceptedCount: number;
};

export const problemKey = (contestId: number, problemIndex: string): string => `${contestId}:${problemIndex}`;

export const isRegularOfficialProblem = (
  problem: CfProblem,
  contestsById: Map<number, CfContest>,
): problem is CfProblem & { contestId: number } => {
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

type CanonicalProblemPlacement = {
  contestId: number;
  problemIndex: string;
  canonicalId: string;
};

export const expandAcceptedProblemsByCanonicalId = (
  db: Db,
  accepted: Map<string, AcceptedProblem>,
): Map<string, AcceptedProblem> => {
  if (accepted.size === 0) return new Map();

  const placements = db
    .prepare(
      `
      SELECT
        contest_id AS contestId,
        problem_index AS problemIndex,
        canonical_id AS canonicalId
      FROM problems
    `,
    )
    .all() as CanonicalProblemPlacement[];
  const placementByKey = new Map(
    placements.map((placement) => [
      problemKey(placement.contestId, placement.problemIndex),
      placement,
    ]),
  );
  const placementsByCanonicalId = new Map<string, CanonicalProblemPlacement[]>();

  for (const placement of placements) {
    const aliases = placementsByCanonicalId.get(placement.canonicalId) ?? [];
    aliases.push(placement);
    placementsByCanonicalId.set(placement.canonicalId, aliases);
  }

  const acceptedByCanonicalId = new Map<string, AcceptedProblem>();
  const acceptedWithoutCanonicalId: AcceptedProblem[] = [];

  for (const item of accepted.values()) {
    const placement = placementByKey.get(problemKey(item.contestId, item.problemIndex));
    if (!placement) {
      acceptedWithoutCanonicalId.push(item);
      continue;
    }

    const existing = acceptedByCanonicalId.get(placement.canonicalId);
    if (!existing) {
      acceptedByCanonicalId.set(placement.canonicalId, { ...item });
      continue;
    }

    existing.acceptedCount += item.acceptedCount;
    if (item.firstAcceptedAtSeconds < existing.firstAcceptedAtSeconds) {
      existing.firstAcceptedAtSeconds = item.firstAcceptedAtSeconds;
      existing.firstSubmissionId = item.firstSubmissionId;
    }
  }

  const expanded = new Map<string, AcceptedProblem>();
  for (const [canonicalId, item] of acceptedByCanonicalId) {
    for (const placement of placementsByCanonicalId.get(canonicalId) ?? []) {
      expanded.set(problemKey(placement.contestId, placement.problemIndex), {
        ...item,
        contestId: placement.contestId,
        problemIndex: placement.problemIndex,
      });
    }
  }
  for (const item of acceptedWithoutCanonicalId) {
    expanded.set(problemKey(item.contestId, item.problemIndex), { ...item });
  }

  return expanded;
};

export const acceptedProblemsFromDb = (db: Db, userId: string): Map<string, AcceptedProblem> => {
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

  const accepted = new Map(
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
  return expandAcceptedProblemsByCanonicalId(db, accepted);
};
