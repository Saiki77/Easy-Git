/**
 * The `obsidian` module for end-to-end runs: the inert unit-test mock, plus
 * a real `requestUrl` on fetch, so the GitHub client talks to the actual API.
 * Only the fields GitHubClient reads (status, text, headers) are provided.
 */

export * from "../mocks/obsidian";

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export async function requestUrl(p: RequestUrlParam): Promise<{
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
}> {
  const res = await fetch(p.url, {
    method: p.method ?? "GET",
    headers: p.headers,
    body: p.body,
  });
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON; callers read .text
  }
  if (p.throw !== false && res.status >= 400) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return { status: res.status, text, json, headers };
}
