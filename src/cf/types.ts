export type CfResponse<T> =
  | { status: "OK"; result: T }
  | { status: "FAILED"; comment: string };

export type CfContest = {
  id: number;
  name: string;
  type?: string;
  phase?: string;
  frozen?: boolean;
  durationSeconds?: number;
  startTimeSeconds?: number;
  relativeTimeSeconds?: number;
};

export type CfProblem = {
  contestId?: number;
  problemsetName?: string;
  index: string;
  name: string;
  type?: string;
  points?: number;
  rating?: number;
  tags: string[];
};

export type CfProblemStatistic = {
  contestId: number;
  index: string;
  solvedCount: number;
};

export type CfProblemset = {
  problems: CfProblem[];
  problemStatistics: CfProblemStatistic[];
};

export type CfSubmission = {
  id: number;
  contestId?: number;
  creationTimeSeconds: number;
  relativeTimeSeconds?: number;
  problem: CfProblem;
  author?: unknown;
  programmingLanguage?: string;
  verdict?: string;
  testset?: string;
  passedTestCount?: number;
  timeConsumedMillis?: number;
  memoryConsumedBytes?: number;
};

