import { fragmentUrl as buildFragmentUrl } from "../fragment-url.js";
import { pageNav as buildPageNav, type PageNav } from "../pagination.js";
import type { ContestTableFilters } from "./filters.js";

export type { PageNav };

export const contestListUrl = (filters: ContestTableFilters, page: number): string => {
  const params = new URLSearchParams();
  if (filters.show !== "all") params.set("show", filters.show);
  if (page !== 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/contests?${query}` : "/contests";
};

export const contestFragmentUrl = (url: string, extra?: Record<string, string>): string =>
  buildFragmentUrl("/contests/fragment", url, extra);

export const contestPageNav = (filters: ContestTableFilters, total: number): PageNav =>
  buildPageNav(filters.page, filters.pageSize, total, contestListUrl(filters, filters.page + 1));
