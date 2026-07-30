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
  /** Official Codeforces rating when present. */
  rating: number | null;
  /** Clist-style estimate used only when official rating is null. */
  estimated_rating: number | null;
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

export type ContestProblemResultRow = {
  contest_id: number;
  problem_index: string;
  name: string;
  url: string;
  rating: number | null;
  estimated_rating: number | null;
  solved_in_contest: number;
  upsolved: number;
  points: number | null;
  rejected_attempt_count: number | null;
  best_submission_time_seconds: number | null;
};

export type ContestShowMode = "all" | "upsolved" | "participated" | "rated";

export type ContestListResult = {
  rows: ContestResultRow[];
  total: number;
};

export type ContestResultRow = {
  contest_id: number;
  contest_name: string;
  start_time_seconds: number | null;
  derived_label: string | null;
  rank: number | null;
  points: number | null;
  penalty: number | null;
  participant_type: string | null;
  old_rating: number | null;
  new_rating: number | null;
  rating_delta: number | null;
  performance: number | null;
  problems: ContestProblemResultRow[];
  hydration_status?: "queued" | "running" | "failed" | null;
  hydration_error?: string | null;
};
