import type {
  CfContest,
  CfProblemset,
  CfRatingChange,
  CfResponse,
  CfStandings,
  CfSubmission,
  CfUser,
} from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_MIN_DELAY_MS = 2100;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;

const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (/Codeforces API request failed: 5\d\d/.test(message)) return true;
  if (
    message.includes("Codeforces API error:") &&
    /Call limit exceeded|Internal server error|Service unavailable/i.test(message)
  ) {
    return true;
  }
  if (error.name === "TimeoutError" || message.includes("timed out")) return true;
  return false;
};

export class CodeforcesClient {
  private readonly baseUrl = "https://codeforces.com/api";
  private readonly minDelayMs: number;
  private readonly fetchTimeoutMs: number;
  private lastRequestAt = 0;

  constructor(minDelayMs = DEFAULT_MIN_DELAY_MS, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    this.minDelayMs = minDelayMs;
    this.fetchTimeoutMs = fetchTimeoutMs;
  }

  async contests(): Promise<CfContest[]> {
    return this.request<CfContest[]>("/contest.list", { gym: "false" });
  }

  async problemset(): Promise<CfProblemset> {
    return this.request<CfProblemset>("/problemset.problems");
  }

  async userInfo(handles: string): Promise<CfUser[]> {
    return this.request<CfUser[]>("/user.info", { handles });
  }

  async userStatus(handle: string): Promise<CfSubmission[]> {
    return this.request<CfSubmission[]>("/user.status", { handle });
  }

  async userRating(handle: string): Promise<CfRatingChange[]> {
    return this.request<CfRatingChange[]>("/user.rating", { handle });
  }

  async contestRatingChanges(contestId: number): Promise<CfRatingChange[]> {
    return this.request<CfRatingChange[]>("/contest.ratingChanges", { contestId: String(contestId) });
  }

  async contestStandings(contestId: number): Promise<CfStandings> {
    // Regular contests reject any param besides contestId (including handles/from/count).
    return this.request<CfStandings>("/contest.standings", {
      contestId: String(contestId),
    });
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        return await this.requestOnce<T>(path, params);
      } catch (error) {
        lastError = error;
        if (attempt >= MAX_RETRIES - 1 || !isRetryableError(error)) throw error;
        await sleep(Math.min(60_000, 2 ** attempt * 2000));
      }
    }

    throw lastError;
  }

  private async requestOnce<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && elapsed < this.minDelayMs) {
      await sleep(this.minDelayMs - elapsed);
    }

    const url = new URL(`${this.baseUrl}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    const response = await fetch(url, {
      headers: {
        "user-agent": "cflist/0.1 (+https://codeforces.com)",
      },
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
    });
    this.lastRequestAt = Date.now();

    if (!response.ok) {
      throw new Error(`Codeforces API request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as CfResponse<T>;
    if (payload.status !== "OK") {
      throw new Error(`Codeforces API error: ${payload.comment}`);
    }

    return payload.result;
  }
}
