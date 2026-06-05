/**
 * Minimal read-only client for the Vercel REST API.
 *
 * AutoApp uses this so the Slack agent can answer "how are deployments / how is
 * operational health?" directly — by reading the latest Vercel deployments and
 * their state — instead of spinning up a Cursor cloud agent for an information
 * request. It only ever reads; it never triggers or mutates deployments.
 *
 * Auth uses the existing `VERCEL_TOKEN`. The optional `VERCEL_PROJECT_ID` and
 * `VERCEL_TEAM_ID` (standard Vercel identifiers) scope the lookup when present.
 */

const VERCEL_API_BASE = "https://api.vercel.com";
const DEFAULT_TIMEOUT_MS = 20000;

export type VercelDeployment = {
  uid: string;
  name?: string;
  url?: string;
  // Newer responses use `state`; some return `readyState`. Treat both as the status.
  state?: string;
  readyState?: string;
  target?: string | null;
  created?: number;
  createdAt?: number;
};

export class VercelApiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "VercelApiError";
    this.status = status;
    this.body = body;
  }
}

function getToken(): string | undefined {
  return process.env.VERCEL_TOKEN?.trim() || undefined;
}

export function isVercelConfigured(): boolean {
  return Boolean(getToken());
}

async function vercelFetch<T>(token: string, path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${VERCEL_API_BASE}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "autoapp",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) {
      throw new VercelApiError(`Vercel API error ${response.status} on GET ${path}`, response.status, text.slice(0, 2000));
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (error) {
    if (error instanceof VercelApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new VercelApiError(`Vercel API request timed out after ${DEFAULT_TIMEOUT_MS}ms on GET ${path}`, 504, "timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function listVercelDeployments(options: { limit?: number; target?: string } = {}): Promise<VercelDeployment[]> {
  const token = getToken();
  if (!token) throw new VercelApiError("VERCEL_TOKEN is required to read Vercel deployments.", 401, "missing token");

  const params = new URLSearchParams();
  params.set("limit", String(options.limit || 5));
  if (options.target) params.set("target", options.target);
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (projectId) params.set("projectId", projectId);
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  if (teamId) params.set("teamId", teamId);

  const data = await vercelFetch<{ deployments?: VercelDeployment[] }>(token, `/v6/deployments?${params.toString()}`);
  return data.deployments || [];
}
