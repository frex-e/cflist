import type { Db } from "../connection.js";
import { resolveCanonicalIdForUpsert } from "../../cf/sync/canonical-problems.js";

export type ProblemUpsertInput = {
  contestId: number;
  problemIndex: string;
  name: string;
  type: string | null;
  points: number | null;
  rating: number | null;
  tags: string[];
  url: string;
  rawJson: string;
  updatedAt: string;
  problemsetName?: string | null;
  solvedCount?: number | null;
};

export type ProblemUpsertSource = "catalog" | "standings";

const deleteProblemTags = (db: Db) =>
  db.prepare("DELETE FROM problem_tags WHERE contest_id = @contestId AND problem_index = @problemIndex");

const insertProblemTag = (db: Db) =>
  db.prepare(`
    INSERT OR IGNORE INTO problem_tags (contest_id, problem_index, tag)
    VALUES (@contestId, @problemIndex, @tag)
  `);

const upsertCatalogProblem = (db: Db) =>
  db.prepare(`
    INSERT INTO problems (
      contest_id,
      problemset_name,
      problem_index,
      name,
      type,
      points,
      rating,
      solved_count,
      tags_json,
      url,
      raw_json,
      updated_at,
      canonical_id
    ) VALUES (
      @contestId,
      @problemsetName,
      @problemIndex,
      @name,
      @type,
      @points,
      @rating,
      @solvedCount,
      @tagsJson,
      @url,
      @rawJson,
      @updatedAt,
      @canonicalId
    )
    ON CONFLICT(contest_id, problem_index) DO UPDATE SET
      problemset_name = excluded.problemset_name,
      name = excluded.name,
      type = excluded.type,
      points = excluded.points,
      rating = excluded.rating,
      solved_count = excluded.solved_count,
      tags_json = excluded.tags_json,
      url = excluded.url,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);

const upsertStandingsProblem = (db: Db) =>
  db.prepare(`
    INSERT INTO problems (
      contest_id,
      problemset_name,
      problem_index,
      name,
      type,
      points,
      rating,
      solved_count,
      tags_json,
      url,
      raw_json,
      updated_at,
      canonical_id
    ) VALUES (
      @contestId,
      NULL,
      @problemIndex,
      @name,
      @type,
      @points,
      @rating,
      NULL,
      @tagsJson,
      @url,
      @rawJson,
      @updatedAt,
      @canonicalId
    )
    ON CONFLICT(contest_id, problem_index) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      points = excluded.points,
      rating = excluded.rating,
      tags_json = excluded.tags_json,
      url = excluded.url,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);

export const upsertProblemWithTags = (
  db: Db,
  input: ProblemUpsertInput,
  source: ProblemUpsertSource,
): void => {
  const tags = [...new Set(input.tags)].sort((a, b) => a.localeCompare(b));
  const tagsJson = JSON.stringify(tags);
  const canonicalId = resolveCanonicalIdForUpsert(
    db,
    input.contestId,
    input.problemIndex,
    input.name,
    source,
  );
  const params = {
    contestId: input.contestId,
    problemIndex: input.problemIndex,
    name: input.name,
    type: input.type,
    points: input.points,
    rating: input.rating,
    tagsJson,
    url: input.url,
    rawJson: input.rawJson,
    updatedAt: input.updatedAt,
    canonicalId,
  };

  if (source === "catalog") {
    upsertCatalogProblem(db).run({
      ...params,
      problemsetName: input.problemsetName ?? null,
      solvedCount: input.solvedCount ?? null,
    });
  } else {
    upsertStandingsProblem(db).run(params);
  }

  deleteProblemTags(db).run({ contestId: input.contestId, problemIndex: input.problemIndex });
  for (const tag of tags) {
    insertProblemTag(db).run({ contestId: input.contestId, problemIndex: input.problemIndex, tag });
  }
};
