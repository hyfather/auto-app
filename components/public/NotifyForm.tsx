"use client";

import { useState } from "react";

type Status = "idle" | "submitting" | "success" | "error";

export function NotifyForm({ source }: { source?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");
    setMessage("");
    try {
      const response = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (response.ok && data.ok) {
        setStatus("success");
        setMessage(data.message || "You're on the list. We'll email you the roundup every Monday.");
        setEmail("");
      } else {
        setStatus("error");
        setMessage(data.error || "Something went wrong. Please try again.");
      }
    } catch {
      setStatus("error");
      setMessage("Network error. Please try again.");
    }
  }

  return (
    <form className="notify" onSubmit={handleSubmit} noValidate>
      <label className="notify-label" htmlFor="notify-email">
        Email address
      </label>
      <div className="notify-row">
        <input
          id="notify-email"
          className="notify-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          aria-label="Email address"
        />
        <button className="button primary notify-button" type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "Adding…" : "Send me the roundup"}
        </button>
      </div>
      {message ? (
        <p className={status === "success" ? "notify-message success" : "notify-message error"} role="status">
          {message}
        </p>
      ) : (
        <p className="notify-hint">No spam—just one short email of SF picks every Monday.</p>
      )}
    </form>
  );
}
