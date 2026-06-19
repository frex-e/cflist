import type { AuthUser } from "../../auth.js";
import type { FilterOptions, ListResult, ProblemFilters } from "../../db/queries.js";
import { defaultSortDirection } from "../../db/queries.js";
import { fragmentUrl as buildFragmentUrl } from "../fragment-url.js";
import { pageNav as buildPageNav, type PageNav } from "../pagination.js";
import type { SyncPanelOptions } from "../sync-panel.js";

export type ProblemsPageOptions = {
  filters: ProblemFilters;
  options: FilterOptions;
  result: ListResult;
  syncPanel: SyncPanelOptions;
  user: AuthUser;
};

export type { PageNav };

export const problemListUrl = (filters: ProblemFilters, page: number): string => {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.minRating !== undefined) params.set("minRating", String(filters.minRating));
  if (filters.maxRating !== undefined) params.set("maxRating", String(filters.maxRating));
  for (const tag of filters.tags) params.append("tags", tag);
  if (filters.tagMode !== "any") params.set("tagMode", filters.tagMode);
  if (filters.contestFamily) params.set("contestFamily", filters.contestFamily);
  for (const division of filters.divisions) params.append("division", division);
  if (filters.solved !== "all") params.set("solved", filters.solved);
  if (filters.showTags) params.set("showTags", "1");
  if (filters.sort !== "contest") params.set("sort", filters.sort);
  if (filters.sortDirection !== defaultSortDirection(filters.sort)) params.set("sortDirection", filters.sortDirection);
  if (filters.pageSize !== 50) params.set("pageSize", String(filters.pageSize));
  if (page !== 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/problems?${query}` : "/problems";
};

export const problemListQuery = (filters: ProblemFilters): string => {
  const url = problemListUrl(filters, 1);
  return url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
};

export const fragmentUrl = (url: string, extra?: Record<string, string>): string =>
  buildFragmentUrl("/problems/fragment", url, extra);

export const pageNav = (filters: ProblemFilters, total: number): PageNav =>
  buildPageNav(filters.page, filters.pageSize, total, problemListUrl(filters, filters.page + 1));
