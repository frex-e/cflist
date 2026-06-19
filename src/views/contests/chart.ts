import type { ContestResultRow } from "../../db/queries.js";

export type ChartMetric = "new_rating" | "performance";

export type ChartPoint = {
  row: ContestResultRow;
  timeSeconds: number;
  value: number;
};

export type ChartScale = {
  yMin: number;
  yMax: number;
};

export const chartValue = (row: ContestResultRow, metric: ChartMetric): number | null => row[metric];

export const chartValues = (rows: ContestResultRow[], metric: ChartMetric): number[] => {
  return rows
    .map((row) => chartValue(row, metric))
    .filter((value): value is number => value !== null);
};

export const chartScale = (rows: ContestResultRow[]): ChartScale => {
  const values = [...chartValues(rows, "new_rating"), ...chartValues(rows, "performance")];
  const maxValue = Math.max(...values, 1600);
  const minValue = Math.min(...values, 1200);

  return {
    yMin: Math.max(0, Math.floor((minValue - 160) / 100) * 100),
    yMax: Math.min(4000, Math.max(1600, Math.ceil((maxValue + 180) / 100) * 100)),
  };
};

export const yearTicks = (
  minTimeSeconds: number,
  maxTimeSeconds: number,
  xForTime: (timeSeconds: number) => number,
): { year: number; x: number }[] => {
  const ticks: { year: number; x: number }[] = [];
  const minYear = new Date(minTimeSeconds * 1000).getUTCFullYear();
  const maxYear = new Date(maxTimeSeconds * 1000).getUTCFullYear();

  for (let year = minYear; year <= maxYear; year += 1) {
    const timeSeconds = Date.UTC(year, 0, 1) / 1000;
    if (timeSeconds < minTimeSeconds || timeSeconds > maxTimeSeconds) continue;
    ticks.push({ year, x: xForTime(timeSeconds) });
  }

  return ticks;
};

export const xForTime = (
  timeSeconds: number,
  minTimeSeconds: number,
  timeRangeSeconds: number,
  marginLeft: number,
  plotWidth: number,
): number => marginLeft + ((timeSeconds - minTimeSeconds) / timeRangeSeconds) * plotWidth;

export const yForValue = (
  value: number,
  yMin: number,
  yMax: number,
  marginTop: number,
  plotHeight: number,
): number => marginTop + ((yMax - value) / (yMax - yMin)) * plotHeight;
