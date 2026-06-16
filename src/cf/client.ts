import type { CfContest, CfProblemset, CfResponse, CfSubmission } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CodeforcesClient {
  private readonly baseUrl = "https://codeforces.com/api";
  private readonly minDelayMs: number;
  private lastRequestAt = 0;

  constructor(minDelayMs = 2100) {
    this.minDelayMs = minDelayMs;
  }

  async contests(): Promise<CfContest[]> {
    return this.request<CfContest[]>("/contest.list", { gym: "false" });
  }

  async problemset(): Promise<CfProblemset> {
    return this.request<CfProblemset>("/problemset.problems");
  }

  async userStatus(handle: string): Promise<CfSubmission[]> {
    return this.request<CfSubmission[]>("/user.status", { handle });
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
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

