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
