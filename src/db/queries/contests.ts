import type { Db } from "../connection.js";
import type { ContestProblemResultRow, ContestResultRow } from "./types.js";

const parseContestProblems = (value: string): ContestProblemResultRow[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as ContestProblemResultRow[] : [];
  } catch {
    return [];
  }
};

export const listUserContestResults = (
  db: Db,
  userId: string,
  limit = 50,
): ContestResultRow[] => {
  const rows = db
    .prepare(
      `
      SELECT
        ucr.contest_id,
        c.name AS contest_name,
        c.start_time_seconds,
        c.derived_label,
        ucr.rank,
        ucr.points,
        ucr.penalty,
        ucr.participant_type,
        ucr.old_rating,
        ucr.new_rating,
        ucr.rating_delta,
        ucr.performance,
        COALESCE(
          (
            SELECT json_group_array(
              json_object(
                'contest_id', ucpr.contest_id,
                'problem_index', ucpr.problem_index,
                'name', p.name,
                'url', p.url,
                'solved_in_contest', ucpr.solved_in_contest,
                'upsolved', ucpr.upsolved,
                'points', ucpr.points,
                'rejected_attempt_count', ucpr.rejected_attempt_count,
                'best_submission_time_seconds', ucpr.best_submission_time_seconds
              )
            )
            FROM user_contest_problem_results ucpr
            JOIN problems p
              ON p.contest_id = ucpr.contest_id
              AND p.problem_index = ucpr.problem_index
            WHERE ucpr.user_id = ucr.user_id
              AND ucpr.contest_id = ucr.contest_id
            ORDER BY ucpr.problem_index ASC
          ),
          '[]'
        ) AS problems_json
      FROM user_contest_results ucr
      JOIN contests c ON c.id = ucr.contest_id
      WHERE ucr.user_id = @userId
      ORDER BY c.start_time_seconds DESC, ucr.contest_id DESC
      LIMIT @limit
    `,
    )
    .all({ userId, limit }) as (Omit<ContestResultRow, "problems"> & { problems_json: string })[];

  return rows.map((row) => ({
    contest_id: row.contest_id,
    contest_name: row.contest_name,
    start_time_seconds: row.start_time_seconds,
    derived_label: row.derived_label,
    rank: row.rank,
    points: row.points,
    penalty: row.penalty,
    participant_type: row.participant_type,
    old_rating: row.old_rating,
    new_rating: row.new_rating,
    rating_delta: row.rating_delta,
    performance: row.performance,
    problems: parseContestProblems(row.problems_json),
  }));
};
