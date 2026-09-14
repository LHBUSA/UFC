-- Paid-only UFC auth: request throttling store.
--
-- The magic-link endpoint now authorizes BEFORE creating a login token, an
-- account or an email. Denied requests therefore leave nothing in
-- ufc_login_tokens, so the old "recent token for this email" throttle cannot
-- see them. This table records every request (allowed or denied) as two HMACs
-- keyed with a server-only secret -- no email, no IP -- so the endpoint can
-- throttle by normalized email AND by client fingerprint without storing either.
--
-- Written and read only by the UFC web server with the service role.
-- Additive: no existing table, row or grant changes.

begin;

create table if not exists public.ufc_auth_request_attempts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  fingerprint_hash text not null check (fingerprint_hash ~ '^[0-9a-f]{64}$'),
  outcome text not null check (char_length(outcome) <= 40)
);

create index if not exists ufc_auth_request_attempts_email_idx
  on public.ufc_auth_request_attempts (email_hash, created_at desc);
create index if not exists ufc_auth_request_attempts_fingerprint_idx
  on public.ufc_auth_request_attempts (fingerprint_hash, created_at desc);
create index if not exists ufc_auth_request_attempts_created_idx
  on public.ufc_auth_request_attempts (created_at);

alter table public.ufc_auth_request_attempts enable row level security;
revoke all on table public.ufc_auth_request_attempts from anon, authenticated;
grant select, insert, delete on table public.ufc_auth_request_attempts to service_role;
grant usage, select on sequence public.ufc_auth_request_attempts_id_seq to service_role;

comment on table public.ufc_auth_request_attempts is
  'Paid-only UFC magic-link throttle. HMAC(email) and HMAC(fingerprint) per request; no plaintext identity. Service role only.';

commit;
