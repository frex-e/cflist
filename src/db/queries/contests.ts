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

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const catalogPastContestClause = `
  AND (c.start_time_seconds IS NULL OR c.start_time_seconds <= @nowSeconds)
`;

const catalogProblemsetContestClause = `
  AND EXISTS (
    SELECT 1
    FROM problems p
    WHERE p.contest_id = c.id
  )
`;

const catalogListableContestClause = `
  ${catalogPastContestClause}
  ${catalogProblemsetContestClause}
`;

export const buildContestShowWhere = (show: ContestShowMode): { clause: string; params: Record<string, never> } => {
  if (show === "upsolved") {
    return {
      clause: `
        AND (
          NOT (ucr.rank IS NULL AND ucr.points IS NULL)
          OR EXISTS (
            SELECT 1
            FROM user_contest_problem_results ucpr
            WHERE ucpr.user_id = ucr.user_id
              AND ucpr.contest_id = ucr.contest_id
              AND ucpr.upsolved = 1
          )
        )`.trim(),
      params: {},
    };
  }
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

const sortContestProblems = (problems: ContestProblemResultRow[]): ContestProblemResultRow[] =>
  [...problems].sort((left, right) =>
    left.problem_index.localeCompare(right.problem_index, "en", { numeric: true }),
  );

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
  problems: sortContestProblems(parseContestProblems(row.problems_json)),
});

const userProblemsJsonSubquery = `
  SELECT json_group_array(
    json_object(
      'contest_id', ucpr.contest_id,
      'problem_index', ucpr.problem_index,
      'name', p.name,
      'url', p.url,
      'rating', p.rating,
      'solved_in_contest', ucpr.solved_in_contest,
      'upsolved', ucpr.upsolved,
      'points', ucpr.points,
      'rejected_attempt_count', ucpr.rejected_attempt_count,
      'best_submission_time_seconds', ucpr.best_submission_time_seconds
    )
    ORDER BY ucpr.problem_index COLLATE NOCASE ASC
  )
  FROM user_contest_problem_results ucpr
  JOIN problems p
    ON p.contest_id = ucpr.contest_id
    AND p.problem_index = ucpr.problem_index
  WHERE ucpr.user_id = ucr.user_id
    AND ucpr.contest_id = ucr.contest_id
`;

const catalogProblemsJsonSubquery = `
  SELECT json_group_array(
    json_object(
      'contest_id', p.contest_id,
      'problem_index', p.problem_index,
      'name', p.name,
      'url', p.url,
      'rating', p.rating,
      'solved_in_contest', 0,
      'upsolved', 0,
      'points', NULL,
      'rejected_attempt_count', NULL,
      'best_submission_time_seconds', NULL
    )
    ORDER BY p.problem_index COLLATE NOCASE ASC
  )
  FROM problems p
  WHERE p.contest_id = c.id
`;

const userContestResultsSelect = `
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
      (${userProblemsJsonSubquery}),
      '[]'
    ) AS problems_json
`;

const catalogContestResultsSelect = `
  SELECT
    c.id AS contest_id,
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
      NULLIF((${userProblemsJsonSubquery}), '[]'),
      (${catalogProblemsJsonSubquery}),
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

  if (show === "all") {
    const rows = db
      .prepare(
        `
        ${catalogContestResultsSelect},
        COUNT(*) OVER () AS _total
        FROM contests c
        LEFT JOIN user_contest_results ucr
          ON ucr.contest_id = c.id
          AND ucr.user_id = @userId
        WHERE 1 = 1
        ${catalogListableContestClause}
        ORDER BY c.start_time_seconds DESC, c.id DESC
        LIMIT @limit OFFSET @offset
      `,
      )
      .all({ userId, nowSeconds: nowSeconds(), limit: pageSize, offset }) as ContestListRow[];

    const total = rows[0]?._total ?? 0;
    return {
      rows: rows.map(mapContestRow),
      total,
    };
  }

  const { clause: showClause } = buildContestShowWhere(show);
  const rows = db
    .prepare(
      `
      ${userContestResultsSelect},
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

export const countCatalogContests = (db: Db): number => {
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM contests c
      WHERE (c.start_time_seconds IS NULL OR c.start_time_seconds <= @nowSeconds)
        AND EXISTS (
          SELECT 1
          FROM problems p
          WHERE p.contest_id = c.id
        )
    `,
    )
    .get({ nowSeconds: nowSeconds() }) as { count: number };
  return row.count;
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
