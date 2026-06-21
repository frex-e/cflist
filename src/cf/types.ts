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

export type CfUser = {
  handle: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  rating?: number;
  maxRating?: number;
};

export type CfRatingChange = {
  contestId: number;
  contestName: string;
  handle: string;
  rank: number;
  ratingUpdateTimeSeconds: number;
  oldRating: number;
  newRating: number;
};

export type CfProblemResult = {
  points: number;
  penalty?: number;
  rejectedAttemptCount?: number;
  type?: string;
  bestSubmissionTimeSeconds?: number;
};

export type CfStandingsRow = {
  party: {
    contestId?: number;
    members: { handle: string; name?: string }[];
    participantType?: string;
    teamId?: number;
    teamName?: string;
    ghost?: boolean;
    room?: number;
    startTimeSeconds?: number;
  };
  rank: number;
  points: number;
  penalty: number;
  problemResults: CfProblemResult[];
  lastSubmissionTimeSeconds?: number;
};

export type CfStandings = {
  contest: CfContest;
  problems: CfProblem[];
  rows: CfStandingsRow[];
};
