import type { ContestResultRow } from "../../db/queries.js";

export type { ContestShowMode } from "../../db/queries.js";
import type { ContestShowMode } from "../../db/queries.js";

const CONTEST_PAGE_SIZE = 50;

export type ContestTableFilters = {
  show: ContestShowMode;
  page: number;
  pageSize: number;
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export const parseContestTableFilters = (searchParams: URLSearchParams): ContestTableFilters => {
  const show = searchParams.get("show");
  const pageParam = searchParams.get("page");
  const parsedPage = pageParam ? Number.parseInt(pageParam, 10) : 1;

  return {
    show: show === "upsolved" || show === "participated" || show === "rated" ? show : "all",
    page: clamp(Number.isFinite(parsedPage) ? parsedPage : 1, 1, 100_000),
    pageSize: CONTEST_PAGE_SIZE,
  };
};

export const isUnratedContest = (row: ContestResultRow): boolean => row.new_rating === null;

export const isUpsolveOnlyContest = (row: ContestResultRow): boolean =>
  row.rank === null && row.points === null;

export const matchesUpsolvedFilter = (row: ContestResultRow): boolean =>
  !isUpsolveOnlyContest(row) || row.problems.some((problem) => problem.upsolved !== 0);

export const filterContestTableRows = (
  rows: ContestResultRow[],
  filters: ContestTableFilters,
): ContestResultRow[] => {
  if (filters.show === "all") return rows;

  return rows.filter((row) => {
    if (filters.show === "upsolved") return matchesUpsolvedFilter(row);
    if (filters.show === "participated") return !isUpsolveOnlyContest(row);
    return !isUnratedContest(row);
  });
};

export const contestTableFilterQuery = (filters: ContestTableFilters): string => {
  const params = new URLSearchParams();
  if (filters.show !== "all") params.set("show", filters.show);
  if (filters.page !== 1) params.set("page", String(filters.page));
  const query = params.toString();
  return query ? `?${query}` : "";
};
