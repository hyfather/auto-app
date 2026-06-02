/**
 * Minimal typed client for the Cursor Cloud Agents API (v1).
 *
 * Docs: https://cursor.com/docs/cloud-agent/api/endpoints
 *
 * Cloud Agents replace the previous Codex-over-Slack implementation worker:
 * AutoApp launches a cloud agent against the connected GitHub repository, the
 * agent opens a pull request, and AutoApp polls the run for status/PR links.
 */

const CURSOR_API_BASE = process.env.CURSOR_API_BASE_URL?.replace(/\/$/, "") || "https://api.cursor.com";
const DEFAULT_TIMEOUT_MS = 20000;

export type CursorRunStatus =
  | "CREATING"
  | "RUNNING"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED"
  | "EXPIRED";

export type CursorGitBranch = { repoUrl?: string; branch?: string; prUrl?: string };

export type CursorRun = {
  id: string;
  agentId: string;
  status: CursorRunStatus;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
  result?: string;
  git?: { branches?: CursorGitBranch[] };
};

export type CursorAgent = {
  id: string;
  name?: string;
  status?: string;
  url?: string;
  latestRunId?: string;
  git?: { branches?: CursorGitBranch[] };
};

export type CreateAgentResult = { agent: CursorAgent; run: CursorRun };

export class CursorApiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "CursorApiError";
    this.status = status;
    this.body = body;
  }
}

const TERMINAL_RUN_STATUSES: CursorRunStatus[] = ["FINISHED", "ERROR", "CANCELLED", "EXPIRED"];

export function isTerminalRunStatus(status?: string): boolean {
  return Boolean(status && TERMINAL_RUN_STATUSES.includes(status as CursorRunStatus));
}

export function isCursorConfigured(): boolean {
  return Boolean(process.env.CURSOR_API_KEY && getRepoUrl());
}

export function getRepoUrl(): string | undefined {
  return process.env.CURSOR_AGENT_REPO_URL?.trim() || undefined;
}

function getStartingRef(): string {
  return process.env.CURSOR_AGENT_STARTING_REF?.trim() || "main";
}

function requireConfig(): { apiKey: string; repoUrl: string } {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  const repoUrl = getRepoUrl();
  if (!apiKey) throw new Error("CURSOR_API_KEY is required to launch a Cursor cloud agent.");
  if (!repoUrl) throw new Error("CURSOR_AGENT_REPO_URL is required to launch a Cursor cloud agent.");
  return { apiKey, repoUrl };
}

function authHeader(apiKey: string): string {
  // The Cloud Agents API accepts Basic auth with the API key as the username
  // and an empty password, or Bearer auth. We use Basic for broad compatibility.
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function cursorFetch<T>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${CURSOR_API_BASE}${path}`, {
      method: init.method || "GET",
      headers: {
        Authorization: authHeader(apiKey),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) {
      throw new CursorApiError(`Cursor API error ${response.status} on ${init.method || "GET"} ${path}`, response.status, text.slice(0, 2000));
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (error) {
    if (error instanceof CursorApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new CursorApiError(`Cursor API request timed out after ${DEFAULT_TIMEOUT_MS}ms on ${init.method || "GET"} ${path}`, 504, "timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export type CreateAgentOptions = {
  prompt: string;
  name?: string;
};

export async function createCloudAgent(options: CreateAgentOptions): Promise<CreateAgentResult> {
  const { apiKey, repoUrl } = requireConfig();
  const model = process.env.CURSOR_AGENT_MODEL?.trim();
  const body: Record<string, unknown> = {
    prompt: { text: options.prompt },
    repos: [{ url: repoUrl, startingRef: getStartingRef() }],
    autoCreatePR: true,
  };
  if (options.name) body.name = options.name.slice(0, 100);
  if (model) body.model = { id: model };
  return cursorFetch<CreateAgentResult>(apiKey, "/v1/agents", { method: "POST", body });
}

export async function createFollowupRun(agentId: string, prompt: string): Promise<{ run: CursorRun }> {
  const { apiKey } = requireConfig();
  return cursorFetch<{ run: CursorRun }>(apiKey, `/v1/agents/${encodeURIComponent(agentId)}/runs`, {
    method: "POST",
    body: { prompt: { text: prompt } },
  });
}

export async function getRun(agentId: string, runId: string): Promise<CursorRun> {
  const { apiKey } = requireConfig();
  return cursorFetch<CursorRun>(apiKey, `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`);
}

export async function getAgent(agentId: string): Promise<CursorAgent> {
  const { apiKey } = requireConfig();
  return cursorFetch<CursorAgent>(apiKey, `/v1/agents/${encodeURIComponent(agentId)}`);
}

/** Pull the first pull-request URL the agent has pushed, if any. */
export function extractPrUrl(source: { git?: { branches?: CursorGitBranch[] } } | undefined): string | undefined {
  return source?.git?.branches?.find((branch) => branch.prUrl)?.prUrl;
}
