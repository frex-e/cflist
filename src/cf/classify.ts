import type { CfContest } from "./types.js";

export type ContestClassification = {
  family: string;
  division: string;
  label: string;
  year: number | null;
};

const yearFromContest = (contest: CfContest): number | null => {
  if (!contest.startTimeSeconds) return null;
  return new Date(contest.startTimeSeconds * 1000).getUTCFullYear();
};

export const classifyContest = (contest: CfContest): ContestClassification => {
  const name = contest.name;
  const normalized = name.replace(/\s+/g, " ").trim();

  let family = "Other";
  if (/educational codeforces round/i.test(normalized)) {
    family = "Educational";
  } else if (/codeforces global round/i.test(normalized)) {
    family = "Global";
  } else if (/codeforces round/i.test(normalized)) {
    family = "Codeforces Round";
  } else if (/kotlin heroes/i.test(normalized)) {
    family = "Kotlin Heroes";
  } else if (/april fools/i.test(normalized)) {
    family = "April Fools";
  } else if (/\bdiv\.?\s*[1-4]\b/i.test(normalized)) {
    family = "Divisional";
  }

  let division = "Unknown";
  if (/\bdiv\.?\s*1\s*\+\s*div\.?\s*2\b/i.test(normalized) || /\bdiv\.?\s*1\s*\+\s*2\b/i.test(normalized)) {
    division = "Div. 1 + Div. 2";
  } else if (/\bdiv\.?\s*1\b/i.test(normalized)) {
    division = "Div. 1";
  } else if (/\bdiv\.?\s*2\b/i.test(normalized)) {
    division = "Div. 2";
  } else if (/\bdiv\.?\s*3\b/i.test(normalized)) {
    division = "Div. 3";
  } else if (/\bdiv\.?\s*4\b/i.test(normalized)) {
    division = "Div. 4";
  } else if (/\bunrated\b/i.test(normalized)) {
    division = "Unrated";
  }

  const label = division === "Unknown" ? family : `${family} (${division})`;
  return { family, division, label, year: yearFromContest(contest) };
};

