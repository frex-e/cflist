import type { Db } from "./connection.js";

type SqlValue = string | number | null;
type SqlParams = Record<string, SqlValue>;

export type ProblemFilters = {
  q?: string;
  minRating?: number;
  maxRating?: number;
  tags: string[];
  tagMode: "all" | "any";
  contestFamily?: string;
  divisions: string[];
  solved: "all" | "solved" | "unsolved";
  showTags: boolean;
  sort: "rating" | "solvedCount" | "contest" | "name";
  sortDirection: "asc" | "desc";
  page: number;
  pageSize: number;
  userId: string;
  cfHandle: string;
};

export type ProblemRow = {
  contest_id: number;
  problem_index: string;
  name: string;
  rating: number | null;
  solved_count: number | null;
  tags_json: string;
  url: string;
  contest_name: string | null;
  derived_family: string | null;
  derived_division: string | null;
  derived_label: string | null;
  cf_solved: number | null;
  solved_override: number | null;
  effective_solved: number;
};

export type ProblemDetail = ProblemRow & {
  type: string | null;
  points: number | null;
  first_accepted_submission_id: number | null;
  first_accepted_at_seconds: number | null;
  accepted_count: number | null;
  override_note: string | null;
  override_updated_at: string | null;
};

export type FilterOptions = {
  ratings: number[];
  tags: string[];
  contestFamilies: string[];
  divisions: string[];
};

export type ListResult = {
  rows: ProblemRow[];
  total: number;
  solved: number;
  unsolved: number;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

export const defaultSortDirection = (sort: ProblemFilters["sort"]): ProblemFilters["sortDirection"] => {
  return sort === "rating" || sort === "name" ? "asc" : "desc";
};

export const normalizeFilters = (input: URLSearchParams, userId: string, cfHandle: string): ProblemFilters => {
  const parseIntParam = (key: string): number | undefined => {
    const value = input.get(key);
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const page = clamp(parseIntParam("page") ?? 1, 1, 100000);
  const pageSize = clamp(parseIntParam("pageSize") ?? 50, 10, 200);
  const tagValues = input.getAll("tags").flatMap((value) => value.split(","));
  const tags = [...new Set(tagValues.map((tag) => tag.trim()).filter(Boolean))];
  const divisionValues = input.getAll("division").flatMap((value) => value.split(","));
  const divisions = [...new Set(divisionValues.map((division) => division.trim()).filter(Boolean))];
  const tagMode = input.get("tagMode") === "all" ? "all" : "any";
  const solved = input.get("solved");
  const sort = input.get("sort");
  const sortDirection = input.get("sortDirection");
  const showTags = input.get("showTags") === "1";
  const normalizedSort =
    sort === "rating" || sort === "solvedCount" || sort === "contest" || sort === "name"
      ? sort
      : "contest";

  return {
    q: input.get("q")?.trim() || undefined,
    minRating: parseIntParam("minRating"),
    maxRating: parseIntParam("maxRating"),
    tags,
    tagMode,
    contestFamily: input.get("contestFamily") || undefined,
    divisions,
    solved: solved === "solved" || solved === "unsolved" ? solved : "all",
    showTags,
    sort: normalizedSort,
    sortDirection:
      sortDirection === "asc" || sortDirection === "desc"
        ? sortDirection
        : defaultSortDirection(normalizedSort),
    page,
    pageSize,
    userId,
    cfHandle,
  };
};

const baseFrom = `
  FROM problems p
  LEFT JOIN contests c ON c.id = p.contest_id
  LEFT JOIN user_problem_status ups
    ON ups.user_id = @userId
    AND ups.contest_id = p.contest_id
    AND ups.problem_index = p.problem_index
  LEFT JOIN user_problem_overrides upo
    ON upo.user_id = @userId
    AND upo.contest_id = p.contest_id
    AND upo.problem_index = p.problem_index
`;

const solvedExpr = "CASE WHEN COALESCE(ups.solved, 0) = 1 OR COALESCE(upo.solved_override, 0) = 1 THEN 1 ELSE 0 END";

const buildWhere = (filters: ProblemFilters): { where: string; params: SqlParams } => {
  const clauses: string[] = [];
  const params: SqlParams = { userId: filters.userId };

  if (filters.q) {
    clauses.push("(p.name LIKE @q OR CAST(p.contest_id AS TEXT) || p.problem_index LIKE @q)");
    params.q = `%${filters.q}%`;
  }
  if (filters.minRating !== undefined) {
    clauses.push("p.rating >= @minRating");
    params.minRating = filters.minRating;
  }
  if (filters.maxRating !== undefined) {
    clauses.push("p.rating <= @maxRating");
    params.maxRating = filters.maxRating;
  }
  if (filters.contestFamily) {
    clauses.push("c.derived_family = @contestFamily");
    params.contestFamily = filters.contestFamily;
  }
  if (filters.divisions.length > 0) {
    const divisionKeys = filters.divisions.map((_, index) => `@division${index}`).join(", ");
    clauses.push(`c.derived_division IN (${divisionKeys})`);
    filters.divisions.forEach((division, index) => {
      params[`division${index}`] = division;
    });
  }
  if (filters.solved === "solved") {
    clauses.push(`${solvedExpr} = 1`);
  } else if (filters.solved === "unsolved") {
    clauses.push(`${solvedExpr} = 0`);
  }

  filters.tags.forEach((tag, index) => {
    const key = `tag${index}`;
    if (filters.tagMode === "all") {
      clauses.push(`
        EXISTS (
          SELECT 1 FROM problem_tags pt
          WHERE pt.contest_id = p.contest_id
            AND pt.problem_index = p.problem_index
            AND pt.tag = @${key}
        )
      `);
    }
    params[key] = tag;
  });

  if (filters.tags.length > 0 && filters.tagMode === "any") {
    const tagKeys = filters.tags.map((_, index) => `@tag${index}`).join(", ");
    clauses.push(`
      EXISTS (
        SELECT 1 FROM problem_tags pt
        WHERE pt.contest_id = p.contest_id
          AND pt.problem_index = p.problem_index
          AND pt.tag IN (${tagKeys})
      )
    `);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
};

const orderBy = (sort: ProblemFilters["sort"], direction: ProblemFilters["sortDirection"]): string => {
  const dir = direction === "asc" ? "ASC" : "DESC";
  if (sort === "rating") return `p.rating IS NULL, p.rating ${dir}, p.contest_id DESC, p.problem_index ASC`;
  if (sort === "solvedCount") return `p.solved_count IS NULL, p.solved_count ${dir}, p.contest_id DESC, p.problem_index ASC`;
  if (sort === "name") return `p.name COLLATE NOCASE ${dir}, p.contest_id DESC, p.problem_index ASC`;
  return `p.contest_id ${dir}, p.problem_index ASC`;
};

export const listProblems = (db: Db, filters: ProblemFilters): ListResult => {
  const { where, params } = buildWhere(filters);
  const offset = (filters.page - 1) * filters.pageSize;
  const paging = { limit: filters.pageSize, offset };

  const rows = db
    .prepare(
      `
      SELECT
        p.contest_id,
        p.problem_index,
        p.name,
        p.rating,
        p.solved_count,
        p.tags_json,
        p.url,
        c.name AS contest_name,
        c.derived_family,
        c.derived_division,
        c.derived_label,
        ups.solved AS cf_solved,
        upo.solved_override,
        ${solvedExpr} AS effective_solved
      ${baseFrom}
      ${where}
      ORDER BY ${orderBy(filters.sort, filters.sortDirection)}
      LIMIT @limit OFFSET @offset
    `,
    )
    .all({ ...params, ...paging }) as ProblemRow[];

  const summary = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ${solvedExpr} = 1 THEN 1 ELSE 0 END) AS solved,
        SUM(CASE WHEN ${solvedExpr} = 0 THEN 1 ELSE 0 END) AS unsolved
      ${baseFrom}
      ${where}
    `,
    )
    .get(params) as { total: number; solved: number | null; unsolved: number | null };

  return {
    rows,
    total: summary.total,
    solved: summary.solved ?? 0,
    unsolved: summary.unsolved ?? 0,
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

export const getFilterOptions = (db: Db): FilterOptions => {
  const ratings = db
    .prepare("SELECT DISTINCT rating FROM problems WHERE rating IS NOT NULL ORDER BY rating ASC")
    .all()
    .map((row) => (row as { rating: number }).rating);

  const tags = db
    .prepare("SELECT DISTINCT tag FROM problem_tags ORDER BY tag COLLATE NOCASE ASC")
    .all()
    .map((row) => (row as { tag: string }).tag);

  const contestFamilies = db
    .prepare(
      "SELECT DISTINCT derived_family FROM contests WHERE derived_family IS NOT NULL ORDER BY derived_family COLLATE NOCASE ASC",
    )
    .all()
    .map((row) => (row as { derived_family: string }).derived_family);

  const divisions = db
    .prepare(
      "SELECT DISTINCT derived_division FROM contests WHERE derived_division IS NOT NULL ORDER BY derived_division COLLATE NOCASE ASC",
    )
    .all()
    .map((row) => (row as { derived_division: string }).derived_division);

  return { ratings, tags, contestFamilies, divisions };
};

export const getLatestSyncRun = (db: Db): { started_at: string; finished_at: string | null; status: string; message: string | null } | undefined => {
  return db
    .prepare(
      "SELECT started_at, finished_at, status, message FROM sync_runs ORDER BY id DESC LIMIT 1",
    )
    .get() as { started_at: string; finished_at: string | null; status: string; message: string | null } | undefined;
};

export const getLatestUserSyncRun = (
  db: Db,
  userId: string,
): { started_at: string; finished_at: string | null; status: string; message: string | null } | undefined => {
  return db
    .prepare(
      `
      SELECT started_at, finished_at, status, message
      FROM sync_runs
      WHERE source = 'codeforces:user' AND user_id = @userId
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get({ userId }) as { started_at: string; finished_at: string | null; status: string; message: string | null } | undefined;
};

export const problemCount = (db: Db): number => {
  const row = db.prepare("SELECT COUNT(*) AS count FROM problems").get() as { count: number };
  return row.count;
};

export const latestSuccessfulSyncAgeMs = (db: Db): number | undefined => {
  const row = db
    .prepare("SELECT finished_at FROM sync_runs WHERE source = 'codeforces:catalog' AND status = 'success' ORDER BY id DESC LIMIT 1")
    .get() as { finished_at: string } | undefined;
  if (!row) return undefined;
  const finishedAt = Date.parse(row.finished_at);
  return Number.isFinite(finishedAt) ? Date.now() - finishedAt : undefined;
};

export const setSolvedOverride = (
  db: Db,
  userId: string,
  contestId: number,
  problemIndex: string,
  solvedOverride: 0 | 1 | null,
  note: string | null,
): void => {
  if (solvedOverride === null && !note) {
    db.prepare(
      `
      DELETE FROM user_problem_overrides
      WHERE user_id = @userId AND contest_id = @contestId AND problem_index = @problemIndex
    `,
    ).run({ userId, contestId, problemIndex });
    return;
  }

  db.prepare(
    `
    INSERT INTO user_problem_overrides (
      user_id,
      contest_id,
      problem_index,
      solved_override,
      note,
      updated_at
    ) VALUES (
      @userId,
      @contestId,
      @problemIndex,
      @solvedOverride,
      @note,
      @updatedAt
    )
    ON CONFLICT(user_id, contest_id, problem_index) DO UPDATE SET
      solved_override = excluded.solved_override,
      note = excluded.note,
      updated_at = excluded.updated_at
  `,
  ).run({
    userId,
    contestId,
    problemIndex,
    solvedOverride,
    note,
    updatedAt: new Date().toISOString(),
  });
};

export const getDefaultFilterQuery = (db: Db, userId: string): string | undefined => {
  const row = db
    .prepare("SELECT query FROM user_default_filters WHERE user_id = @userId")
    .get({ userId }) as { query: string } | undefined;
  return row?.query;
};

export const setDefaultFilterQuery = (db: Db, userId: string, query: string): void => {
  if (!query) {
    db.prepare("DELETE FROM user_default_filters WHERE user_id = @userId").run({ userId });
    return;
  }

  db.prepare(
    `
    INSERT INTO user_default_filters (user_id, query, updated_at)
    VALUES (@userId, @query, @updatedAt)
    ON CONFLICT(user_id) DO UPDATE SET
      query = excluded.query,
      updated_at = excluded.updated_at
  `,
  ).run({ userId, query, updatedAt: new Date().toISOString() });
};
