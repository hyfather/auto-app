"use client";

import { useState, type FormEvent } from "react";

const defaultMission = "Create useful intelligent apps while keeping autonomous changes safe, observable, and aligned to operator intent.";

type ApiResult = Record<string, unknown>;

export function AdminConsole() {
  const [token, setToken] = useState("");
  const [mission, setMission] = useState(defaultMission);
  const [runId, setRunId] = useState("");
  const [reason, setReason] = useState("Operator reviewed the run and confirmed the next lifecycle action is safe.");
  const [output, setOutput] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);

  async function callAdmin(path: string, body?: ApiResult) {
    setIsLoading(true);
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-auto-app-actor": "browser-admin"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json();
    setOutput(JSON.stringify(payload, null, 2));
    setIsLoading(false);
  }

  function runAgentLoop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void callAdmin("/api/admin/agent-loop", {
      mission,
      dryRun: true,
      maxIdeas: 3,
      includeInternetResearch: false
    });
  }

  return (
    <section className="adminShell">
      <div className="adminControls panel">
        <h2>Admin control plane</h2>
        <label htmlFor="admin-token">Admin token</label>
        <input
          id="admin-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="AUTO_APP_ADMIN_TOKEN"
        />
        <button type="button" onClick={() => void callAdmin("/api/admin/runs")} disabled={!token || isLoading}>
          Load improvement runs
        </button>
      </div>

      <div className="adminControls panel">
        <h2>Run lifecycle</h2>
        <label htmlFor="run-id">Run ID</label>
        <input
          id="run-id"
          value={runId}
          onChange={(event) => setRunId(event.target.value)}
          placeholder="improvement run id"
        />
        <label htmlFor="run-reason">Reason</label>
        <textarea id="run-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        <div className="buttonRow">
          <button
            type="button"
            onClick={() => void callAdmin(`/api/admin/runs/${runId}/approve`, { reason })}
            disabled={!token || !runId || isLoading}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => void callAdmin(`/api/admin/runs/${runId}/reject`, { reason })}
            disabled={!token || !runId || isLoading}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => void callAdmin(`/api/admin/runs/${runId}/dispatch`, { reason })}
            disabled={!token || !runId || isLoading}
          >
            Dispatch
          </button>
          <button
            type="button"
            onClick={() =>
              void callAdmin(`/api/admin/runs/${runId}/validate`, { reason, checks: ["operator-reviewed"] })
            }
            disabled={!token || !runId || isLoading}
          >
            Validate
          </button>
          <button
            type="button"
            onClick={() => void callAdmin(`/api/admin/runs/${runId}/merge`, { reason })}
            disabled={!token || !runId || isLoading}
          >
            Merge
          </button>
        </div>
      </div>

      <form className="adminControls panel" onSubmit={runAgentLoop}>
        <h2>Agentic discovery</h2>
        <label htmlFor="agent-mission">Mission for the subagent loop</label>
        <textarea id="agent-mission" value={mission} onChange={(event) => setMission(event.target.value)} />
        <button type="submit" disabled={!token || isLoading}>
          {isLoading ? "Running..." : "Run dry-run agent loop"}
        </button>
        <p className="hint">The loop converts metrics and mission context into queued improvement runs for admin review.</p>
      </form>

      {output ? <pre className="planOutput adminOutput">{output}</pre> : null}
    </section>
  );
}
