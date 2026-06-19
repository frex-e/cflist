import type { Db } from "../connection.js";
import type { ContestListResult, ContestProblemResultRow, ContestResultRow, ContestShowMode } from "./types.js";

const DEFAULT_PAGE_SIZE = 50;

export type ContestListOptions = {
  show?: ContestShowMode;
  page?: number;
  pageSize?: number;
};

type ContestListRow = Omit<ContestResultRow, "problems"> & {
  problems_json: string;
  _total: number;
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export const buildContestShowWhere = (show: ContestShowMode): { clause: string; params: Record<string, never> } => {
  if (show === "participated") {
    return { clause: "AND NOT (ucr.rank IS NULL AND ucr.points IS NULL)", params: {} };
  }
  if (show === "rated") {
    return { clause: "AND ucr.new_rating IS NOT NULL", params: {} };
  }
  return { clause: "", params: {} };
};

const parseContestProblems = (value: string): ContestProblemResultRow[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as ContestProblemResultRow[] : [];
  } catch {
    return [];
  }
};

const mapContestRow = (row: ContestListRow): ContestResultRow => ({
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
});

const contestResultsSelect = `
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
`;

export const listUserContestResults = (
  db: Db,
  userId: string,
  options: ContestListOptions = {},
): ContestListResult => {
  const show = options.show ?? "all";
  const page = clamp(options.page ?? 1, 1, 100_000);
  const pageSize = clamp(options.pageSize ?? DEFAULT_PAGE_SIZE, 10, 200);
  const offset = (page - 1) * pageSize;
  const { clause: showClause } = buildContestShowWhere(show);

  const rows = db
    .prepare(
      `
      ${contestResultsSelect},
      COUNT(*) OVER () AS _total
      FROM user_contest_results ucr
      JOIN contests c ON c.id = ucr.contest_id
      WHERE ucr.user_id = @userId
      ${showClause}
      ORDER BY c.start_time_seconds DESC, ucr.contest_id DESC
      LIMIT @limit OFFSET @offset
    `,
    )
    .all({ userId, limit: pageSize, offset }) as ContestListRow[];

  const total = rows[0]?._total ?? 0;
  return {
    rows: rows.map(mapContestRow),
    total,
  };
};

export const listUserContestChartRows = (db: Db, userId: string): ContestResultRow[] => {
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
        ucr.performance
      FROM user_contest_results ucr
      JOIN contests c ON c.id = ucr.contest_id
      WHERE ucr.user_id = @userId
        AND ucr.new_rating IS NOT NULL
      ORDER BY c.start_time_seconds DESC, ucr.contest_id DESC
    `,
    )
    .all({ userId }) as Omit<ContestResultRow, "problems">[];

  return rows.map((row) => ({ ...row, problems: [] }));
};

export const countUserContestResults = (
  db: Db,
  userId: string,
  show: ContestShowMode = "all",
): number => {
  const { clause: showClause } = buildContestShowWhere(show);
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM user_contest_results ucr
      WHERE ucr.user_id = @userId
      ${showClause}
    `,
    )
    .get({ userId }) as { count: number };

  return row.count;
};
