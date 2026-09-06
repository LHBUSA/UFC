import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const SESSION_COOKIE = "pbe_ufc_session";
export const MAGIC_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export type Account = {
  id: string;
  email: string;
  display_name: string | null;
  role: "member" | "admin" | "owner";
  plan: "free" | "pro" | "owner";
  unlimited: boolean;
  access_expires_at: string | null;
  last_login_at: string | null;
};

type LoginToken = {
  token_hash: string;
  email: string;
  next_path: string | null;
  expires_at: string;
  used_at: string | null;
};

type SessionRow = {
  session_hash: string;
  account_id: string;
  expires_at: string;
  account?: Account | Account[] | null;
};

function sbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Accept: "application/json",
    ...extra,
  };
}

export function authConfigured(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

async function sb<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!authConfigured()) throw new Error("auth_not_configured");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: sbHeaders({ ...(init.headers as Record<string, string> || {}) }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`supabase_${res.status}:${text.slice(0, 220)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export function normalizeEmail(value: unknown): string {
  const email = String(value || "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export function safeNextPath(value: unknown, fallback = "/account"): string {
  const path = String(value || "").trim();
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) return fallback;
  return path.slice(0, 1200) || fallback;
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function recentLoginRequestExists(email: string, seconds = 60): Promise<boolean> {
  const since = new Date(Date.now() - seconds * 1000).toISOString();
  const rows = await sb<Array<{ token_hash: string }>>(
    `ufc_login_tokens?select=token_hash&email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(since)}&limit=1`,
  );
  return rows.length > 0;
}

export async function createLoginToken(email: string, nextPath: string | null, fingerprint?: string | null): Promise<{ raw: string; expiresAt: string }> {
  const raw = newOpaqueToken();
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + MAGIC_TTL_SECONDS * 1000).toISOString();
  await sb<unknown>("ufc_login_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ token_hash: tokenHash, email, next_path: nextPath, expires_at: expiresAt, request_fingerprint: fingerprint || null }),
  });
  return { raw, expiresAt };
}

export async function consumeLoginToken(raw: string): Promise<LoginToken | null> {
  if (!raw || raw.length > 180) return null;
  const tokenHash = hashToken(raw);
  const rows = await sb<LoginToken[]>(
    `ufc_login_tokens?select=token_hash,email,next_path,expires_at,used_at&token_hash=eq.${tokenHash}&limit=1`,
  );
  const row = rows[0];
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) return null;
  const now = new Date().toISOString();
  await sb<unknown>(`ufc_login_tokens?token_hash=eq.${tokenHash}&used_at=is.null`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ used_at: now }),
  });
  return row;
}

export async function getOrCreateAccount(email: string): Promise<Account> {
  const existing = await sb<Account[]>(`ufc_accounts?select=*&email=eq.${encodeURIComponent(email)}&limit=1`);
  if (existing[0]) return existing[0];
  const created = await sb<Account[]>("ufc_accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ email, role: "member", plan: "free", unlimited: false }),
  });
  if (!created[0]) throw new Error("account_create_failed");
  return created[0];
}

export async function createSession(account: Account, userAgent?: string | null): Promise<{ raw: string; expiresAt: string }> {
  const raw = newOpaqueToken();
  const sessionHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const uaHash = userAgent ? hashToken(userAgent).slice(0, 32) : null;
  await sb<unknown>("ufc_sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ session_hash: sessionHash, account_id: account.id, expires_at: expiresAt, user_agent_hash: uaHash }),
  });
  await sb<unknown>(`ufc_accounts?id=eq.${account.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  return { raw, expiresAt };
}

export async function deleteSession(raw: string | null | undefined): Promise<void> {
  if (!raw) return;
  await sb<unknown>(`ufc_sessions?session_hash=eq.${hashToken(raw)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => undefined);
}

export async function getCurrentAccount(): Promise<Account | null> {
  if (!authConfigured()) return null;
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const now = new Date().toISOString();
    const rows = await sb<Array<SessionRow & { account: Account | Account[] | null }>>(
      `ufc_sessions?select=session_hash,account_id,expires_at,account:ufc_accounts(*)&session_hash=eq.${hashToken(raw)}&expires_at=gt.${encodeURIComponent(now)}&limit=1`,
    );
    const row = rows[0];
    if (!row) return null;
    const account = Array.isArray(row.account) ? row.account[0] : row.account;
    return account || null;
  } catch (error) {
    console.error("[auth] session lookup failed", String((error as Error)?.message || error).slice(0, 180));
    return null;
  }
}

export function hasProAccess(account: Account | null): boolean {
  if (!account) return false;
  if (account.unlimited || account.role === "owner" || account.plan === "owner") return true;
  if (account.plan !== "pro") return false;
  return !account.access_expires_at || Date.parse(account.access_expires_at) > Date.now();
}
