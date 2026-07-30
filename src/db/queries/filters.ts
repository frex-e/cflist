import type { ProblemFilters } from "./types.js";

type SqlValue = string | number | null;
type SqlParams = Record<string, SqlValue>;

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

export const problemListJoins = `
  FROM problems p
  LEFT JOIN contests c ON c.id = p.contest_id
  LEFT JOIN canonical_cf_solved cs ON cs.canonical_id = p.canonical_id
  LEFT JOIN user_problem_overrides upo
    ON upo.user_id = @userId
    AND upo.canonical_id = p.canonical_id
`;

export const baseFrom = `
  FROM problems p
  LEFT JOIN contests c ON c.id = p.contest_id
  LEFT JOIN user_problem_status ups
    ON ups.user_id = @userId
    AND ups.contest_id = p.contest_id
    AND ups.problem_index = p.problem_index
  LEFT JOIN user_problem_overrides upo
    ON upo.user_id = @userId
    AND upo.canonical_id = p.canonical_id
`;

export const solvedExpr =
  "CASE WHEN COALESCE(ups.solved, 0) = 1 OR COALESCE(upo.solved_override, 0) = 1 THEN 1 ELSE 0 END";

export const buildWhere = (
  filters: ProblemFilters,
  options: { includeSolvedFilter?: boolean } = {},
): { where: string; params: SqlParams } => {
  const includeSolvedFilter = options.includeSolvedFilter ?? true;
  const clauses: string[] = [];
  const params: SqlParams = { userId: filters.userId };

  if (filters.q) {
    clauses.push("(p.name LIKE @q OR c.name LIKE @q OR CAST(p.contest_id AS TEXT) || p.problem_index LIKE @q)");
    params.q = `%${filters.q}%`;
  }
  if (filters.minRating !== undefined) {
    clauses.push("COALESCE(p.rating, p.estimated_rating) >= @minRating");
    params.minRating = filters.minRating;
  }
  if (filters.maxRating !== undefined) {
    clauses.push("COALESCE(p.rating, p.estimated_rating) <= @maxRating");
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
  if (includeSolvedFilter && filters.solved === "solved") {
    clauses.push(
      "(COALESCE(cs.cf_solved, 0) = 1 OR COALESCE(upo.solved_override, 0) = 1)",
    );
  } else if (includeSolvedFilter && filters.solved === "unsolved") {
    clauses.push(
      "(COALESCE(cs.cf_solved, 0) = 0 AND COALESCE(upo.solved_override, 0) = 0)",
    );
  }

  if (filters.tags.length > 0 && filters.tagMode === "all") {
    const tagKeys = filters.tags.map((_, index) => `@tag${index}`).join(", ");
    filters.tags.forEach((tag, index) => {
      params[`tag${index}`] = tag;
    });
    clauses.push(`
      (
        SELECT COUNT(DISTINCT pt.tag)
        FROM problem_tags pt
        WHERE pt.contest_id = p.contest_id
          AND pt.problem_index = p.problem_index
          AND pt.tag IN (${tagKeys})
      ) = @tagCount
    `);
    params.tagCount = filters.tags.length;
  } else if (filters.tags.length > 0) {
    const tagKeys = filters.tags.map((_, index) => `@tag${index}`).join(", ");
    filters.tags.forEach((tag, index) => {
      params[`tag${index}`] = tag;
    });
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

export const orderBy = (
  sort: ProblemFilters["sort"],
  direction: ProblemFilters["sortDirection"],
  alias = "p",
): string => {
  const dir = direction === "asc" ? "ASC" : "DESC";
  const column = (name: string): string => (alias ? `${alias}.${name}` : name);
  if (sort === "rating") {
    const effective = alias
      ? `COALESCE(${column("rating")}, ${column("estimated_rating")})`
      : "COALESCE(rating, estimated_rating)";
    return `${effective} IS NULL, ${effective} ${dir}, ${column("contest_id")} DESC, ${column("problem_index")} ASC`;
  }
  if (sort === "solvedCount") {
    return `${column("solved_count")} IS NULL, ${column("solved_count")} ${dir}, ${column("contest_id")} DESC, ${column("problem_index")} ASC`;
  }
  if (sort === "name") {
    return `${column("name")} COLLATE NOCASE ${dir}, ${column("contest_id")} DESC, ${column("problem_index")} ASC`;
  }
  return `${column("contest_id")} ${dir}, ${column("problem_index")} ASC`;
};

export const solvedFilterWhere = (filters: ProblemFilters): string => {
  if (filters.solved === "solved") return "WHERE p.effective_solved = 1";
  if (filters.solved === "unsolved") return "WHERE p.effective_solved = 0";
  return "";
};

const canonicalCfSolvedCte = `
  canonical_cf_solved AS (
    SELECT
      p.canonical_id,
      MAX(CASE WHEN ups.solved = 1 THEN 1 ELSE 0 END) AS cf_solved
    FROM problems p
    LEFT JOIN user_problem_status ups
      ON ups.user_id = @userId
      AND ups.contest_id = p.contest_id
      AND ups.problem_index = p.problem_index
    GROUP BY p.canonical_id
  )
`;

export const dedupedProblemsCte = (filters: ProblemFilters, where: string): string => `
  WITH ${canonicalCfSolvedCte},
  filtered AS (
    SELECT
      p.contest_id,
      p.problem_index,
      p.canonical_id,
      p.name,
      p.rating,
      p.estimated_rating,
      p.solved_count,
      p.tags_json,
      p.url,
      c.name AS contest_name,
      c.derived_family,
      c.derived_division,
      c.derived_label,
      COALESCE(cs.cf_solved, 0) AS cf_solved,
      CASE WHEN COALESCE(upo.solved_override, 0) = 1 THEN 1 ELSE 0 END AS solved_override,
      CASE
        WHEN COALESCE(cs.cf_solved, 0) = 1 OR COALESCE(upo.solved_override, 0) = 1 THEN 1
        ELSE 0
      END AS effective_solved
    ${problemListJoins}
    ${where}
  ),
  deduped AS (
    SELECT *
    FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY canonical_id
          ORDER BY ${orderBy(filters.sort, filters.sortDirection, "")}
        ) AS duplicate_rank
      FROM filtered
    )
    WHERE duplicate_rank = 1
  )
`;
