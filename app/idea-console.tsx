"use client";

import { useState, type FormEvent } from "react";

const defaultMission = "Create useful intelligent apps while keeping every autonomous change reviewable, reversible, and aligned to user intent.";
const defaultIdea = "Build an app that sends personalized birthday greeting cards from a user's saved contacts and style preferences.";

export function IdeaConsole() {
  const [mission, setMission] = useState(defaultMission);
  const [idea, setIdea] = useState(defaultIdea);
  const [result, setResult] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);

  async function submitIdea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setResult("");

    const response = await fetch("/api/improve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission, idea, source: "human", riskTolerance: "low", dryRun: true })
    });
    const body = await response.json();
    setResult(JSON.stringify(body, null, 2));
    setIsLoading(false);
  }

  return (
    <form className="ideaForm" onSubmit={submitIdea}>
      <label htmlFor="mission">Mission</label>
      <textarea id="mission" name="mission" value={mission} onChange={(event) => setMission(event.target.value)} />
      <label htmlFor="idea">Idea</label>
      <textarea id="idea" name="idea" value={idea} onChange={(event) => setIdea(event.target.value)} />
      <button type="submit">{isLoading ? "Planning..." : "Generate improvement plan"}</button>
      <p className="hint">The API defaults to dry-run mode so operators can inspect the plan before enabling GitHub writes.</p>
      {result ? <pre className="planOutput">{result}</pre> : null}
    </form>
  );
}
