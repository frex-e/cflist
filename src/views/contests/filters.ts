import type { ContestResultRow } from "../../db/queries.js";

export type ContestTableFilters = {
  hideUnrated: boolean;
  hideUpsolveOnly: boolean;
};

export const parseContestTableFilters = (searchParams: URLSearchParams): ContestTableFilters => ({
  hideUnrated: searchParams.get("hideUnrated") === "1",
  hideUpsolveOnly: searchParams.get("hideUpsolve") === "1",
});

export const isUnratedContest = (row: ContestResultRow): boolean => row.new_rating === null;

export const isUpsolveOnlyContest = (row: ContestResultRow): boolean =>
  row.rank === null && row.points === null;

export const filterContestTableRows = (
  rows: ContestResultRow[],
  filters: ContestTableFilters,
): ContestResultRow[] => {
  return rows.filter((row) => {
    if (filters.hideUnrated && isUnratedContest(row)) return false;
    if (filters.hideUpsolveOnly && isUpsolveOnlyContest(row)) return false;
    return true;
  });
};

export const contestTableFilterQuery = (filters: ContestTableFilters): string => {
  const params = new URLSearchParams();
  if (filters.hideUnrated) params.set("hideUnrated", "1");
  if (filters.hideUpsolveOnly) params.set("hideUpsolve", "1");
  const query = params.toString();
  return query ? `?${query}` : "";
};
