import type { Db } from "../connection.js";
import {
  buildWhere,
  dedupedProblemsCte,
  orderBy,
  solvedExpr,
  solvedFilterWhere,
  baseFrom,
} from "./filters.js";
import type { ListResult, ProblemDetail, ProblemFilters, ProblemRow } from "./types.js";

type ListRow = ProblemRow & {
  _total: number;
  _solved: number;
  _unsolved: number;
};

export const listProblems = (db: Db, filters: ProblemFilters): ListResult => {
  const { where, params } = buildWhere(filters, { includeSolvedFilter: false });
  const offset = (filters.page - 1) * filters.pageSize;
  const paging = { limit: filters.pageSize, offset };
  const dedupedCte = dedupedProblemsCte(filters, where);
  const dedupedWhere = solvedFilterWhere(filters);

  const rows = db
    .prepare(
      `
      ${dedupedCte},
      filtered_deduped AS (
        SELECT * FROM deduped p
        ${dedupedWhere}
      ),
      with_totals AS (
        SELECT
          *,
          COUNT(*) OVER () AS _total,
          SUM(CASE WHEN effective_solved = 1 THEN 1 ELSE 0 END) OVER () AS _solved,
          SUM(CASE WHEN effective_solved = 0 THEN 1 ELSE 0 END) OVER () AS _unsolved
        FROM filtered_deduped
      )
      SELECT
        contest_id,
        problem_index,
        name,
        rating,
        solved_count,
        tags_json,
        url,
        contest_name,
        derived_family,
        derived_division,
        derived_label,
        cf_solved,
        solved_override,
        effective_solved,
        _total,
        _solved,
        _unsolved
      FROM with_totals
      ORDER BY ${orderBy(filters.sort, filters.sortDirection, "")}
      LIMIT @limit OFFSET @offset
    `,
    )
    .all({ ...params, ...paging }) as ListRow[];

  if (rows.length === 0) {
    const summary = db
      .prepare(
        `
        ${dedupedCte}
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN p.effective_solved = 1 THEN 1 ELSE 0 END) AS solved,
          SUM(CASE WHEN p.effective_solved = 0 THEN 1 ELSE 0 END) AS unsolved
        FROM deduped p
        ${dedupedWhere}
      `,
      )
      .get(params) as { total: number; solved: number | null; unsolved: number | null };

    return {
      rows: [],
      total: summary?.total ?? 0,
      solved: summary?.solved ?? 0,
      unsolved: summary?.unsolved ?? 0,
    };
  }

  const first = rows[0];
  return {
    rows: rows.map((row) => ({
      contest_id: row.contest_id,
      problem_index: row.problem_index,
      name: row.name,
      rating: row.rating,
      solved_count: row.solved_count,
      tags_json: row.tags_json,
      url: row.url,
      contest_name: row.contest_name,
      derived_family: row.derived_family,
      derived_division: row.derived_division,
      derived_label: row.derived_label,
      cf_solved: row.cf_solved,
      solved_override: row.solved_override,
      effective_solved: row.effective_solved,
    })),
    total: first._total,
    solved: first._solved,
    unsolved: first._unsolved,
  };
};

export const getProblem = (
  db: Db,
  userId: string,
  contestId: number,
  problemIndex: string,
): ProblemDetail | undefined => {
  return db
    .prepare(
      `
      SELECT
        p.contest_id,
        p.problem_index,
        p.name,
        p.type,
        p.points,
        p.rating,
        p.solved_count,
        p.tags_json,
        p.url,
        c.name AS contest_name,
        c.derived_family,
        c.derived_division,
        c.derived_label,
        ups.solved AS cf_solved,
        ups.first_accepted_submission_id,
        ups.first_accepted_at_seconds,
        ups.accepted_count,
        upo.solved_override,
        upo.note AS override_note,
        upo.updated_at AS override_updated_at,
        ${solvedExpr} AS effective_solved
      ${baseFrom}
      WHERE p.contest_id = @contestId AND p.problem_index = @problemIndex
    `,
    )
    .get({ userId, contestId, problemIndex }) as ProblemDetail | undefined;
};
