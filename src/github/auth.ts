import { requestUrl } from "obsidian";
import { EASY_GIT_OAUTH_CLIENT_ID, GitHubAuth } from "../types";
import { GitHubClient, GitHubApiError } from "./client";

export interface UserInfo {
  login: string;
  scopes?: string[];
}

export async function validatePat(token: string, baseUrl?: string): Promise<UserInfo> {
  const client = new GitHubClient({ token, baseUrl });
  const user = await client.request<{ login: string }>("GET", "/user");
  return { login: user.login };
}

export async function getAuthenticatedUser(client: GitHubClient): Promise<UserInfo> {
  try {
    const user = await client.request<{ login: string }>("GET", "/user");
    return { login: user.login };
  } catch (e) {
    // Self-hosted Forgejo/Gitea tokens scoped to specific repositories cannot
    // have user-level (read:user) permission, so /user returns 403. Fall back
    // to a repo-scoped endpoint so the connection test still confirms the token
    // works for sync operations. GitHub's /user works for any valid token, so a
    // 403 there is a genuine error (missing scope, SSO, or rate limit) and must
    // propagate unchanged; the Forgejo-only fallback never runs against GitHub.
    if (e instanceof GitHubApiError && e.status === 403 && !client.isGitHub()) {
      // /user/repos also requires read:user on Forgejo; use /repos/search
      // instead which only needs read:repository.
      await client.request("GET", "/repos/search?limit=1");
      return { login: "" };
    }
    throw e;
  }
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export async function startDeviceFlow(
  clientId: string = EASY_GIT_OAUTH_CLIENT_ID,
  scope = "repo workflow",
): Promise<DeviceCodeResponse> {
  const response = await requestUrl({
    url: "https://github.com/login/device/code",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_id: clientId, scope }),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Device flow start failed: HTTP ${response.status} ${response.text}`);
  }
  const data = JSON.parse(response.text) as DeviceCodeResponse & {
    error?: string;
    error_description?: string;
  };
  if (data.error) {
    throw new Error(`Device flow start failed: ${data.error_description ?? data.error}`);
  }
  return data;
}

export async function pollDeviceToken(
  deviceCode: string,
  clientId: string = EASY_GIT_OAUTH_CLIENT_ID,
): Promise<DeviceTokenResponse> {
  const response = await requestUrl({
    url: "https://github.com/login/oauth/access_token",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Token poll HTTP ${response.status}: ${response.text}`);
  }
  return JSON.parse(response.text) as DeviceTokenResponse;
}

export function describeAuth(auth: GitHubAuth): string {
  if (auth.method === "none" || !auth.token) return "Not signed in";
  const who = auth.username ? ` as ${auth.username}` : "";
  if (auth.method === "pat") return `Signed in via PAT${who}`;
  if (auth.method === "oauth") return `Signed in via GitHub${who}`;
  return "Not signed in";
}

export function describeAuthError(e: unknown): string {
  if (e instanceof GitHubApiError) {
    if (e.status === 401) return "Invalid or expired token. Please sign in again.";
    if (e.status === 403) {
      if (e.rateLimitRemaining === 0) {
        const reset = e.rateLimitReset ? new Date(e.rateLimitReset * 1000) : null;
        return `Rate limited${reset ? ` until ${reset.toLocaleTimeString()}` : ""}.`;
      }
      return "Forbidden. Check that the token has repository read/write access.";
    }
    if (e.status === 404) return "Not found. Check repo name and your access.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
