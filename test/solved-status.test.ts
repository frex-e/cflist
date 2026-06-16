import assert from "node:assert/strict";
import test from "node:test";
import { acceptedProblemsFromSubmissions } from "../src/cf/sync.js";
import type { CfContest, CfSubmission } from "../src/cf/types.js";

const contests = new Map<number, CfContest>([
  [100, { id: 100, name: "Codeforces Round 100 (Div. 2)" }],
]);

test("builds accepted problem records from OK submissions", () => {
  const submissions: CfSubmission[] = [
    {
      id: 3,
      contestId: 100,
      creationTimeSeconds: 30,
      verdict: "WRONG_ANSWER",
      problem: { contestId: 100, index: "A", name: "A", tags: [] },
    },
    {
      id: 2,
      contestId: 100,
      creationTimeSeconds: 20,
      verdict: "OK",
      problem: { contestId: 100, index: "A", name: "A", tags: [] },
    },
    {
      id: 1,
      contestId: 100,
      creationTimeSeconds: 10,
      verdict: "OK",
      problem: { contestId: 100, index: "A", name: "A", tags: [] },
    },
  ];

  const accepted = acceptedProblemsFromSubmissions(submissions, contests);
  const item = accepted.get("100:A");

  assert.equal(accepted.size, 1);
  assert.equal(item?.acceptedCount, 2);
  assert.equal(item?.firstSubmissionId, 1);
  assert.equal(item?.firstAcceptedAtSeconds, 10);
});

test("ignores gyms and non-regular problemset submissions", () => {
  const submissions: CfSubmission[] = [
    {
      id: 1,
      contestId: 999,
      creationTimeSeconds: 10,
      verdict: "OK",
      problem: { contestId: 999, index: "A", name: "Gym", tags: [] },
    },
    {
      id: 2,
      creationTimeSeconds: 20,
      verdict: "OK",
      problem: {
        contestId: 100,
        problemsetName: "acmsguru",
        index: "1",
        name: "Other",
        tags: [],
      },
    },
  ];

  const accepted = acceptedProblemsFromSubmissions(submissions, contests);
  assert.equal(accepted.size, 0);
});

