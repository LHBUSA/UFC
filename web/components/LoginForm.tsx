"use client";

import { FormEvent, useState } from "react";

export function LoginForm({ next = "/account" }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setMessage("");
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "We could not send the sign-in link.");
      setState("sent");
      setMessage(body?.message || "Check your inbox for your secure sign-in link.");
    } catch (error) {
      setState("error");
      setMessage(String((error as Error)?.message || error));
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <label className="eyebrow dim" htmlFor="login-email">Email address</label>
      <div className="login-row">
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-describedby="login-note login-status"
        />
        <button className="btn gold" type="submit" disabled={state === "sending" || state === "sent"}>
          {state === "sending" ? "Sending…" : state === "sent" ? "Link sent" : "Send secure link"}
        </button>
      </div>
      <p id="login-note" className="faint label">No password. The link expires in 15 minutes; your verified browser stays signed in for 30 days.</p>
      {message && <div id="login-status" role="status" className={`login-status ${state}`}>{message}</div>}
    </form>
  );
}
