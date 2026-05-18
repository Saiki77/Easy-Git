import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { GITHUB_API_BASE } from "../types";

export interface GitHubClientOptions {
  token: string;
  userAgent?: string;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;
  readonly rateLimitRemaining?: number;
  readonly rateLimitReset?: number;

  constructor(args: {
    status: number;
    url: string;
    message: string;
    body: unknown;
    rateLimitRemaining?: number;
    rateLimitReset?: number;
  }) {
    super(args.message);
    this.status = args.status;
    this.url = args.url;
    this.body = args.body;
    this.rateLimitRemaining = args.rateLimitRemaining;
    this.rateLimitReset = args.rateLimitReset;
  }
}

export interface RateLimitInfo {
  remaining: number;
  reset: number;
}

export class GitHubClient {
  private token: string;
  private userAgent: string;
  lastRateLimit?: RateLimitInfo;

  constructor(opts: GitHubClientOptions) {
    this.token = opts.token;
    this.userAgent = opts.userAgent ?? "Easy-Git-Obsidian-Plugin";
  }

  setToken(token: string): void {
    this.token = token;
  }

  hasToken(): boolean {
    return this.token.length > 0;
  }

  async request<T = unknown>(
    method: string,
    pathOrUrl: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${GITHUB_API_BASE}${pathOrUrl}`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.userAgent,
      ...(extraHeaders ?? {}),
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (body !== undefined && body !== null) {
      headers["Content-Type"] = "application/json";
    }

    const params: RequestUrlParam = {
      url,
      method,
      headers,
      throw: false,
    };
    if (body !== undefined && body !== null) {
      params.body = JSON.stringify(body);
    }

    let response: RequestUrlResponse;
    try {
      response = await requestUrl(params);
    } catch (e) {
      throw new GitHubApiError({
        status: 0,
        url,
        message: `Network error: ${e instanceof Error ? e.message : String(e)}`,
        body: null,
      });
    }

    this.updateRateLimit(response.headers);

    if (response.status >= 200 && response.status < 300) {
      if (response.status === 204) return undefined as T;
      const text = response.text;
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }

    let parsedBody: unknown = null;
    try {
      parsedBody = JSON.parse(response.text);
    } catch {
      parsedBody = response.text;
    }
    const errMessage =
      (parsedBody && typeof parsedBody === "object" && "message" in parsedBody
        ? String((parsedBody as { message: unknown }).message)
        : `HTTP ${response.status}`) +
      ` (${method} ${url})`;
    throw new GitHubApiError({
      status: response.status,
      url,
      message: errMessage,
      body: parsedBody,
      rateLimitRemaining: this.lastRateLimit?.remaining,
      rateLimitReset: this.lastRateLimit?.reset,
    });
  }

  async paginate<T>(
    path: string,
    options: { perPage?: number; maxPages?: number } = {},
  ): Promise<T[]> {
    const perPage = options.perPage ?? 100;
    const maxPages = options.maxPages ?? 5;
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const url = `${path}${sep}per_page=${perPage}&page=${page}`;
      const batch = await this.request<T[]>("GET", url);
      if (!Array.isArray(batch)) break;
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out;
  }

  private updateRateLimit(headers: Record<string, string>): void {
    const remainingStr =
      headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
    const resetStr = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
    if (remainingStr === undefined) return;
    const remaining = Number(remainingStr);
    const reset = Number(resetStr ?? "0");
    if (!Number.isNaN(remaining)) {
      this.lastRateLimit = { remaining, reset };
    }
  }
}
