export type RatingTier = {
  name: string;
  min: number;
  max: number;
  dotClass: string;
  textClass: string;
  chartClass: string;
};

export const RATING_TIERS: RatingTier[] = [
  { name: "Newbie", min: 0, max: 1200, dotClass: "rank-newbie", textClass: "rating-newbie", chartClass: "chart-band-newbie" },
  { name: "Pupil", min: 1200, max: 1400, dotClass: "rank-pupil", textClass: "rating-pupil", chartClass: "chart-band-pupil" },
  { name: "Specialist", min: 1400, max: 1600, dotClass: "rank-specialist", textClass: "rating-specialist", chartClass: "chart-band-specialist" },
  { name: "Expert", min: 1600, max: 1900, dotClass: "rank-expert", textClass: "rating-expert", chartClass: "chart-band-expert" },
  { name: "Candidate Master", min: 1900, max: 2100, dotClass: "rank-candidate-master", textClass: "rating-candidate-master", chartClass: "chart-band-candidate-master" },
  { name: "Master", min: 2100, max: 2300, dotClass: "rank-master", textClass: "rating-master", chartClass: "chart-band-master" },
  { name: "International Master", min: 2300, max: 2400, dotClass: "rank-international-master", textClass: "rating-international-master", chartClass: "chart-band-international-master" },
  { name: "Grandmaster", min: 2400, max: 2600, dotClass: "rank-grandmaster", textClass: "rating-grandmaster", chartClass: "chart-band-grandmaster" },
  { name: "International Grandmaster", min: 2600, max: 3000, dotClass: "rank-international-grandmaster", textClass: "rating-international-grandmaster", chartClass: "chart-band-international-grandmaster" },
  { name: "Legendary Grandmaster", min: 3000, max: 4000, dotClass: "rank-legendary-grandmaster", textClass: "rating-legendary-grandmaster", chartClass: "chart-band-legendary-grandmaster" },
];

export const CHART_THRESHOLDS = [1200, 1400, 1600, 1900, 2100, 2300, 2400, 2600, 3000];

type RatingTitle = {
  name: string;
  className: string;
  textClassName: string;
};

export const ratingTitle = (rating: number | null): RatingTitle => {
  if (rating === null) return { name: "Unrated", className: "rank-unrated", textClassName: "rating-unrated" };
  const tier = RATING_TIERS.find((item) => rating >= item.min && rating < item.max);
  if (!tier) {
    const last = RATING_TIERS.at(-1)!;
    return { name: last.name, className: last.dotClass, textClassName: last.textClass };
  }
  return { name: tier.name, className: tier.dotClass, textClassName: tier.textClass };
};

/** Official rating when present; otherwise clist-style estimate. */
export const effectiveProblemRating = (
  rating: number | null,
  estimatedRating: number | null | undefined,
): number | null => rating ?? estimatedRating ?? null;

export const RATING_FILTER_STEP = 100;

export type RatingFilterSliderBounds = {
  /** Lowest selectable rating bound (rounded down to step). */
  minBound: number;
  /** Highest selectable rating bound (rounded up to step). */
  maxBound: number;
  /** Range input minimum; thumb here means no minRating (Any). */
  sliderMin: number;
  /** Range input maximum; thumb here means no maxRating (Any). */
  sliderMax: number;
  step: number;
};

/**
 * Build rating slider extents from catalog effective ratings.
 *
 * Estimates are often not multiples of 100, so bounds are snapped to
 * `RATING_FILTER_STEP`. "Any" sits one step outside the rated span so the
 * catalog min/max (e.g. 800–3500) remain selectable — previously those
 * endpoints meant Any, which made unrated/unestimated problems flicker in
 * and out and made a full rated-range filter impossible.
 */
export const ratingFilterSliderBounds = (
  ratings: number[],
  step: number = RATING_FILTER_STEP,
): RatingFilterSliderBounds => {
  const safeStep = step > 0 ? step : RATING_FILTER_STEP;
  const rawMin = ratings[0] ?? 800;
  const rawMax = ratings.at(-1) ?? 3500;
  const minBound = Math.floor(rawMin / safeStep) * safeStep;
  const maxBound = Math.max(minBound, Math.ceil(rawMax / safeStep) * safeStep);
  return {
    minBound,
    maxBound,
    sliderMin: minBound - safeStep,
    sliderMax: maxBound + safeStep,
    step: safeStep,
  };
};

export const isEstimatedProblemRating = (
  rating: number | null,
  estimatedRating: number | null | undefined,
): boolean => rating === null && estimatedRating != null;

export const formatProblemRating = (
  rating: number | null,
  estimatedRating: number | null | undefined,
): string => {
  if (rating !== null) return String(rating);
  if (estimatedRating != null) return `~${estimatedRating}`;
  return "";
};

export const chartBands = (): Pick<RatingTier, "name" | "min" | "max" | "chartClass">[] => {
  return RATING_TIERS.map((tier) => ({
    name: tier.name,
    min: tier.min,
    max: tier.max,
    chartClass: tier.chartClass,
  }));
};
