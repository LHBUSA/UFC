-- UFC fighter media pipeline v1: reviewed, rights-aware fighter portraits
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive. Three tables, one view, five functions, triggers on the new tables
-- only. No existing row, table, view or function is modified. ufc_images and
-- ufc_image_candidates stay exactly as they are; the new tables reference them
-- (on delete set null) so provenance survives without coupling.
--
-- WHY
-- Public surfaces used to pick a fighter photo in two ways: the newest
-- ufc_images row for the fighter, then a hotlinked ESPN headshot synthesised
-- from espn_athlete_id. Neither path proved that the face was the fighter.
-- An HTTP 200 from a CDN is availability, not identity (Quentin Pasley,
-- 2026-09-10: the ESPN slot resolved and showed someone else), and 368 of the
-- 540 stored rows carry no recorded identity evidence at all.
--
-- THE CONTRACT
--   ufc_fighter_media_candidates  anything that MIGHT be a portrait. Never read
--                                 by a public surface.
--   ufc_fighter_media_assets      a candidate a named reviewer approved, with
--                                 the identity evidence and rights attached.
--   ufc_media_quarantine          images that must never be used again, for
--                                 anyone. Enforced by trigger on both tables.
--   ufc_fighter_portrait_eligible the only relation web/lib/fighterMedia.ts
--                                 reads: approved + verified + primary + not
--                                 quarantined. Surface/commercial policy is
--                                 applied on top of it in TypeScript.
--
-- Promotion is one function, ufc_media_review_candidate(), so approve / reject
-- / quarantine are atomic and the one-primary-per-fighter rule cannot be
-- raced from two browser tabs.
--
-- SECURITY
-- RLS on, no policies, no anon/authenticated grants, security_invoker view,
-- no SECURITY DEFINER function. Every function has EXECUTE revoked from
-- public/anon/authenticated: Supabase grants EXECUTE on new public functions
-- to anon by default, and PostgREST would otherwise expose the review RPC to
-- anyone holding the anon key.

begin;

-- ---------------------------------------------------------------------------
-- 0. Vocabulary shared by candidates and assets
-- ---------------------------------------------------------------------------
-- source_type: where the bytes come from.
-- license_type: the rights basis. Commercial use is only consistent with a
--   known, affirmative basis (see ufc_fighter_media_assets_commercial_basis).
-- surface_policy: where an approved asset may appear at all, independent of
--   rights. internal_only = review UI only.

-- ---------------------------------------------------------------------------
-- 1. Quarantine (created first: the other tables' triggers consult it)
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_media_quarantine (
  id              uuid primary key default gen_random_uuid(),
  image_url       text not null,
  -- Query string and fragment stripped, lower-cased. Over-matching is the
  -- safe direction for a block list.
  image_key       text generated always as (lower(regexp_replace(btrim(image_url), '[?#].*$', ''))) stored,
  source_url      text,
  fighter_id      uuid references public.ufc_fighters(id) on delete set null, -- who it was attached to, for context only
  reason          text not null check (btrim(reason) <> ''),
  quarantined_by  text not null check (btrim(quarantined_by) <> ''),
  quarantined_at  timestamptz not null default now(),
  candidate_id    uuid,
  asset_id        uuid,
  lifted_at       timestamptz,
  lifted_by       text,
  lift_reason     text,
  constraint ufc_media_quarantine_lift_is_explained
    check (lifted_at is null or (coalesce(btrim(lifted_by), '') <> '' and coalesce(btrim(lift_reason), '') <> ''))
);

create unique index if not exists ufc_media_quarantine_active_image
  on public.ufc_media_quarantine (image_key) where lifted_at is null;
create index if not exists ufc_media_quarantine_active_source
  on public.ufc_media_quarantine (source_url) where lifted_at is null and source_url is not null;

create or replace function public.ufc_media_is_quarantined(p_image_url text, p_source_url text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.ufc_media_quarantine q
    where q.lifted_at is null
      and (
        q.image_key = lower(regexp_replace(btrim(coalesce(p_image_url, '')), '[?#].*$', ''))
        or (p_source_url is not null and q.source_url is not null and q.source_url = p_source_url)
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Approved assets
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_fighter_media_assets (
  id                      uuid primary key default gen_random_uuid(),
  fighter_id              uuid not null references public.ufc_fighters(id) on delete cascade,
  image_url               text not null check (image_url ~ '^https://'),
  image_key               text generated always as (lower(regexp_replace(btrim(image_url), '[?#].*$', ''))) stored,
  storage_key             text,          -- key in the ufc-media bucket when the bytes are stored first-party
  legacy_image_id         uuid references public.ufc_images(id) on delete set null,
  candidate_id            uuid,          -- FK added below, after the candidates table exists
  source_url              text not null check (btrim(source_url) <> ''),
  source_name             text not null check (btrim(source_name) <> ''),
  source_type             text not null check (source_type in (
                            'wikimedia_commons', 'public_domain', 'us_government', 'official_press',
                            'licensed_editorial', 'espn', 'first_party', 'other')),
  license_type            text not null default 'unknown' check (license_type in (
                            'cc0', 'public_domain', 'cc_by', 'cc_by_sa', 'editorial_license', 'press_kit',
                            'first_party', 'display_only', 'all_rights_reserved', 'unknown')),
  license_label           text,          -- as the source states it, e.g. 'CC BY-SA 4.0'
  author                  text,
  commercial_use_allowed  boolean not null default false,
  derivative_use_allowed  boolean not null default false,
  attribution_required    boolean not null default true,
  attribution_text        text,
  verified_identity       boolean not null default false,
  identity_evidence       jsonb not null default '{}'::jsonb,
  review_status           text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected', 'quarantined', 'retired')),
  review_reason           text,
  reviewed_by             text,
  reviewed_at             timestamptz,
  suitability_score       numeric(5,2) check (suitability_score is null or (suitability_score >= 0 and suitability_score <= 100)),
  priority_score          numeric(8,2) not null default 0,
  width                   integer check (width is null or width > 0),
  height                  integer check (height is null or height > 0),
  focal_x                 numeric(5,4) check (focal_x is null or (focal_x >= 0 and focal_x <= 1)),
  focal_y                 numeric(5,4) check (focal_y is null or (focal_y >= 0 and focal_y <= 1)),
  is_primary              boolean not null default false,
  surface_policy          text not null default 'all_surfaces' check (surface_policy in ('all_surfaces', 'standard_surfaces', 'internal_only')),
  last_verified_at        timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint ufc_fighter_media_assets_fighter_image unique (fighter_id, image_key),
  -- Approved means: identity verified, evidence on file, a named reviewer, a
  -- verification timestamp. The resolver checks the same things again.
  constraint ufc_fighter_media_assets_approval_complete check (
    review_status <> 'approved'
    or (verified_identity
        and identity_evidence <> '{}'::jsonb
        and last_verified_at is not null
        and coalesce(btrim(reviewed_by), '') <> '')
  ),
  constraint ufc_fighter_media_assets_primary_is_approved check (not is_primary or review_status = 'approved'),
  -- A commercial-use flag with no affirmative rights basis is a data error.
  constraint ufc_fighter_media_assets_commercial_basis check (
    not commercial_use_allowed
    or license_type in ('cc0', 'public_domain', 'cc_by', 'cc_by_sa', 'editorial_license', 'press_kit', 'first_party')
  ),
  constraint ufc_fighter_media_assets_attribution_present check (
    review_status <> 'approved' or not attribution_required or coalesce(btrim(attribution_text), '') <> ''
  ),
  constraint ufc_fighter_media_assets_rejection_explained check (
    review_status not in ('rejected', 'quarantined', 'retired') or coalesce(btrim(review_reason), '') <> ''
  )
);

-- Requirement 3: at most one primary portrait per fighter.
create unique index if not exists ufc_fighter_media_assets_one_primary
  on public.ufc_fighter_media_assets (fighter_id) where is_primary;
create index if not exists ufc_fighter_media_assets_status
  on public.ufc_fighter_media_assets (review_status, fighter_id);
create index if not exists ufc_fighter_media_assets_legacy
  on public.ufc_fighter_media_assets (legacy_image_id) where legacy_image_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Candidates (the review queue)
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_fighter_media_candidates (
  id                        uuid primary key default gen_random_uuid(),
  fighter_id                uuid not null references public.ufc_fighters(id) on delete cascade,
  image_url                 text not null check (image_url ~ '^https://'),
  image_key                 text generated always as (lower(regexp_replace(btrim(image_url), '[?#].*$', ''))) stored,
  thumbnail_url             text,
  storage_key               text,
  legacy_image_id           uuid references public.ufc_images(id) on delete set null,
  legacy_candidate_id       uuid references public.ufc_image_candidates(id) on delete set null,
  source_url                text not null check (btrim(source_url) <> ''),
  source_name               text not null check (btrim(source_name) <> ''),
  source_type               text not null check (source_type in (
                              'wikimedia_commons', 'public_domain', 'us_government', 'official_press',
                              'licensed_editorial', 'espn', 'first_party', 'other')),
  license_type              text not null default 'unknown' check (license_type in (
                              'cc0', 'public_domain', 'cc_by', 'cc_by_sa', 'editorial_license', 'press_kit',
                              'first_party', 'display_only', 'all_rights_reserved', 'unknown')),
  license_label             text,
  author                    text,
  commercial_use_allowed    boolean not null default false,
  derivative_use_allowed    boolean not null default false,
  attribution_required      boolean not null default true,
  attribution_text          text,
  identity_evidence         jsonb not null default '{}'::jsonb,
  identity_confidence       numeric(4,3) not null default 0 check (identity_confidence >= 0 and identity_confidence <= 1),
  suitability_score         numeric(5,2) check (suitability_score is null or (suitability_score >= 0 and suitability_score <= 100)),
  priority_score            numeric(8,2) not null default 0,
  fighter_priority          numeric(6,2) not null default 0,
  queue_reasons             text[] not null default '{}',
  width                     integer check (width is null or width > 0),
  height                    integer check (height is null or height > 0),
  focal_x                   numeric(5,4) check (focal_x is null or (focal_x >= 0 and focal_x <= 1)),
  focal_y                   numeric(5,4) check (focal_y is null or (focal_y >= 0 and focal_y <= 1)),
  proposed_surface_policy   text not null default 'all_surfaces' check (proposed_surface_policy in ('all_surfaces', 'standard_surfaces', 'internal_only')),
  flags                     text[] not null default '{}',   -- generator warnings shown to the reviewer
  status                    text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'quarantined', 'superseded')),
  review_reason             text,
  reviewed_by               text,
  reviewed_at               timestamptz,
  promoted_asset_id         uuid references public.ufc_fighter_media_assets(id) on delete set null,
  discovered_by             text not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint ufc_fighter_media_candidates_fighter_image unique (fighter_id, image_key),
  constraint ufc_fighter_media_candidates_decision_explained check (
    status not in ('rejected', 'quarantined') or coalesce(btrim(review_reason), '') <> ''
  )
);

create index if not exists ufc_fighter_media_candidates_queue
  on public.ufc_fighter_media_candidates (status, priority_score desc);
create index if not exists ufc_fighter_media_candidates_fighter
  on public.ufc_fighter_media_candidates (fighter_id, status);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ufc_fighter_media_assets_candidate_fk') then
    alter table public.ufc_fighter_media_assets
      add constraint ufc_fighter_media_assets_candidate_fk
      foreign key (candidate_id) references public.ufc_fighter_media_candidates(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Triggers: timestamps, and quarantine blocks re-use
-- ---------------------------------------------------------------------------
create or replace function public.ufc_media_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ufc_fighter_media_assets_touch on public.ufc_fighter_media_assets;
create trigger trg_ufc_fighter_media_assets_touch
before update on public.ufc_fighter_media_assets
for each row execute function public.ufc_media_touch_updated_at();

drop trigger if exists trg_ufc_fighter_media_candidates_touch on public.ufc_fighter_media_candidates;
create trigger trg_ufc_fighter_media_candidates_touch
before update on public.ufc_fighter_media_candidates
for each row execute function public.ufc_media_touch_updated_at();

-- A quarantined image re-entering the queue (a generator re-run, a manual
-- insert, someone flipping a status back to pending) lands as quarantined.
create or replace function public.ufc_media_candidate_quarantine_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('pending', 'approved') and public.ufc_media_is_quarantined(new.image_url, new.source_url) then
    new.status := 'quarantined';
    new.review_reason := coalesce(nullif(btrim(new.review_reason), ''), 'blocked: matches an active ufc_media_quarantine entry');
    new.reviewed_by := coalesce(new.reviewed_by, 'system:quarantine');
    new.reviewed_at := coalesce(new.reviewed_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ufc_fighter_media_candidates_quarantine on public.ufc_fighter_media_candidates;
create trigger trg_ufc_fighter_media_candidates_quarantine
before insert or update on public.ufc_fighter_media_candidates
for each row execute function public.ufc_media_candidate_quarantine_guard();

-- An asset cannot be approved (and therefore cannot be primary) while its
-- image or source is quarantined. This is a hard error, not a silent rewrite:
-- the only way to reach it is a deliberate write.
create or replace function public.ufc_media_asset_quarantine_guard()
returns trigger
language plpgsql
as $$
begin
  if new.review_status = 'approved' and public.ufc_media_is_quarantined(new.image_url, new.source_url) then
    raise exception 'ufc_fighter_media_assets: % matches an active quarantine entry and cannot be approved', new.image_url
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ufc_fighter_media_assets_quarantine on public.ufc_fighter_media_assets;
create trigger trg_ufc_fighter_media_assets_quarantine
before insert or update on public.ufc_fighter_media_assets
for each row execute function public.ufc_media_asset_quarantine_guard();

-- Quarantining an image takes it out of service everywhere at once.
create or replace function public.ufc_media_quarantine_cascade()
returns trigger
language plpgsql
as $$
begin
  if new.lifted_at is not null then
    return new;
  end if;
  update public.ufc_fighter_media_assets a
     set review_status = 'quarantined',
         is_primary = false,
         review_reason = 'quarantined: ' || new.reason,
         reviewed_by = new.quarantined_by,
         reviewed_at = now()
   where a.review_status <> 'quarantined'
     and (a.image_key = new.image_key or (new.source_url is not null and a.source_url = new.source_url));
  update public.ufc_fighter_media_candidates c
     set status = 'quarantined',
         review_reason = 'quarantined: ' || new.reason,
         reviewed_by = new.quarantined_by,
         reviewed_at = now()
   where c.status in ('pending', 'approved')
     and (c.image_key = new.image_key or (new.source_url is not null and c.source_url = new.source_url));
  return new;
end;
$$;

drop trigger if exists trg_ufc_media_quarantine_cascade on public.ufc_media_quarantine;
create trigger trg_ufc_media_quarantine_cascade
after insert on public.ufc_media_quarantine
for each row execute function public.ufc_media_quarantine_cascade();

-- ---------------------------------------------------------------------------
-- 5. Review: one atomic entry point for approve / reject / quarantine
-- ---------------------------------------------------------------------------
create or replace function public.ufc_media_quarantine_image(
  p_image_url text,
  p_source_url text,
  p_fighter_id uuid,
  p_reason text,
  p_by text,
  p_candidate_id uuid default null,
  p_asset_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'quarantine requires a reason'; end if;
  if coalesce(btrim(p_by), '') = '' then raise exception 'quarantine requires a named operator'; end if;
  insert into public.ufc_media_quarantine (image_url, source_url, fighter_id, reason, quarantined_by, candidate_id, asset_id)
  values (p_image_url, p_source_url, p_fighter_id, p_reason, p_by, p_candidate_id, p_asset_id)
  on conflict (image_key) where lifted_at is null do nothing
  returning id into v_id;
  if v_id is null then
    -- Already quarantined under this image key: the cascade ran when that row
    -- was inserted and the guards block anything since. Return the existing id.
    select id into v_id from public.ufc_media_quarantine
     where lifted_at is null and image_key = lower(regexp_replace(btrim(p_image_url), '[?#].*$', ''));
  end if;
  return v_id;
end;
$$;

create or replace function public.ufc_media_review_candidate(
  p_candidate_id uuid,
  p_action text,
  p_reason text,
  p_reviewer text,
  p_make_primary boolean default true
)
returns jsonb
language plpgsql
as $$
declare
  c public.ufc_fighter_media_candidates%rowtype;
  v_asset_id uuid;
  v_has_primary boolean;
  v_quarantine_id uuid;
begin
  if coalesce(btrim(p_reviewer), '') = '' then
    raise exception 'review requires a named reviewer';
  end if;

  select * into c from public.ufc_fighter_media_candidates where id = p_candidate_id for update;
  if not found then
    raise exception 'candidate % not found', p_candidate_id;
  end if;

  if p_action = 'approve' then
    if c.status <> 'pending' then
      raise exception 'candidate % is %, only pending candidates can be approved', p_candidate_id, c.status;
    end if;
    if public.ufc_media_is_quarantined(c.image_url, c.source_url) then
      raise exception 'candidate % matches an active quarantine entry', p_candidate_id;
    end if;
    if c.identity_evidence = '{}'::jsonb then
      raise exception 'candidate % has no identity evidence on file', p_candidate_id;
    end if;

    insert into public.ufc_fighter_media_assets (
      fighter_id, image_url, storage_key, legacy_image_id, candidate_id,
      source_url, source_name, source_type, license_type, license_label, author,
      commercial_use_allowed, derivative_use_allowed, attribution_required, attribution_text,
      verified_identity, identity_evidence, review_status, review_reason, reviewed_by, reviewed_at,
      suitability_score, priority_score, width, height, focal_x, focal_y,
      is_primary, surface_policy, last_verified_at
    ) values (
      c.fighter_id, c.image_url, c.storage_key, c.legacy_image_id, c.id,
      c.source_url, c.source_name, c.source_type, c.license_type, c.license_label, c.author,
      c.commercial_use_allowed, c.derivative_use_allowed, c.attribution_required, c.attribution_text,
      true,
      c.identity_evidence || jsonb_build_object('review', jsonb_build_object(
        'reviewed_by', p_reviewer, 'reviewed_at', now(), 'reason', p_reason, 'candidate_id', c.id,
        'identity_confidence_at_review', c.identity_confidence)),
      'approved', p_reason, p_reviewer, now(),
      c.suitability_score, c.priority_score, c.width, c.height, c.focal_x, c.focal_y,
      false, c.proposed_surface_policy, now()
    )
    on conflict (fighter_id, image_key) do update set
      review_status = 'approved',
      verified_identity = true,
      identity_evidence = excluded.identity_evidence,
      review_reason = excluded.review_reason,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      candidate_id = excluded.candidate_id,
      commercial_use_allowed = excluded.commercial_use_allowed,
      derivative_use_allowed = excluded.derivative_use_allowed,
      attribution_required = excluded.attribution_required,
      attribution_text = excluded.attribution_text,
      license_type = excluded.license_type,
      license_label = excluded.license_label,
      surface_policy = excluded.surface_policy,
      last_verified_at = excluded.last_verified_at
    returning id into v_asset_id;

    select exists (
      select 1 from public.ufc_fighter_media_assets
       where fighter_id = c.fighter_id and is_primary and id <> v_asset_id
    ) into v_has_primary;

    if p_make_primary or not v_has_primary then
      update public.ufc_fighter_media_assets set is_primary = false
       where fighter_id = c.fighter_id and is_primary and id <> v_asset_id;
      update public.ufc_fighter_media_assets set is_primary = true where id = v_asset_id;
    end if;

    update public.ufc_fighter_media_candidates
       set status = 'approved', promoted_asset_id = v_asset_id,
           review_reason = p_reason, reviewed_by = p_reviewer, reviewed_at = now()
     where id = c.id;

    return jsonb_build_object('candidate_id', c.id, 'status', 'approved', 'asset_id', v_asset_id,
                              'is_primary', (select is_primary from public.ufc_fighter_media_assets where id = v_asset_id));

  elsif p_action = 'reject' then
    if coalesce(btrim(p_reason), '') = '' then raise exception 'reject requires a reason'; end if;
    if c.status not in ('pending', 'superseded') then
      raise exception 'candidate % is %, only pending candidates can be rejected', p_candidate_id, c.status;
    end if;
    update public.ufc_fighter_media_candidates
       set status = 'rejected', review_reason = p_reason, reviewed_by = p_reviewer, reviewed_at = now()
     where id = c.id;
    return jsonb_build_object('candidate_id', c.id, 'status', 'rejected');

  elsif p_action = 'quarantine' then
    if coalesce(btrim(p_reason), '') = '' then raise exception 'quarantine requires a reason'; end if;
    v_quarantine_id := public.ufc_media_quarantine_image(c.image_url, c.source_url, c.fighter_id, p_reason, p_reviewer, c.id, c.promoted_asset_id);
    -- The cascade trigger already moved a pending/approved candidate; a
    -- rejected one is moved here so the queue shows the stronger decision.
    update public.ufc_fighter_media_candidates
       set status = 'quarantined', review_reason = p_reason, reviewed_by = p_reviewer, reviewed_at = now()
     where id = c.id;
    return jsonb_build_object('candidate_id', c.id, 'status', 'quarantined', 'quarantine_id', v_quarantine_id);

  else
    raise exception 'unknown review action %', p_action;
  end if;
end;
$$;

-- Quarantine an already-approved asset found to be wrong on a live page.
create or replace function public.ufc_media_quarantine_asset(p_asset_id uuid, p_reason text, p_by text)
returns jsonb
language plpgsql
as $$
declare
  a public.ufc_fighter_media_assets%rowtype;
  v_quarantine_id uuid;
begin
  select * into a from public.ufc_fighter_media_assets where id = p_asset_id for update;
  if not found then raise exception 'asset % not found', p_asset_id; end if;
  v_quarantine_id := public.ufc_media_quarantine_image(a.image_url, a.source_url, a.fighter_id, p_reason, p_by, a.candidate_id, a.id);
  return jsonb_build_object('asset_id', a.id, 'status', 'quarantined', 'quarantine_id', v_quarantine_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The one relation public pages read
-- ---------------------------------------------------------------------------
create or replace view public.ufc_fighter_portrait_eligible
with (security_invoker = true) as
select
  a.id, a.fighter_id, a.image_url, a.storage_key, a.legacy_image_id,
  a.source_url, a.source_name, a.source_type, a.license_type, a.license_label, a.author,
  a.commercial_use_allowed, a.derivative_use_allowed, a.attribution_required, a.attribution_text,
  a.verified_identity, a.review_status, a.is_primary, a.surface_policy,
  a.width, a.height, a.focal_x, a.focal_y, a.suitability_score, a.last_verified_at
from public.ufc_fighter_media_assets a
where a.review_status = 'approved'
  and a.verified_identity
  and a.is_primary
  and a.last_verified_at is not null
  and a.surface_policy <> 'internal_only'
  and not public.ufc_media_is_quarantined(a.image_url, a.source_url);

comment on view public.ufc_fighter_portrait_eligible is
  'Approved, identity-verified, primary, non-quarantined fighter portraits. The only portrait relation public pages read (web/lib/fighterMedia.ts), which applies the surface/commercial policy on top. security_invoker = true. Server-read only (service_role).';

-- ---------------------------------------------------------------------------
-- 7. Grants: service role only
-- ---------------------------------------------------------------------------
alter table public.ufc_media_quarantine enable row level security;
alter table public.ufc_fighter_media_assets enable row level security;
alter table public.ufc_fighter_media_candidates enable row level security;

revoke all on public.ufc_media_quarantine from public, anon, authenticated;
revoke all on public.ufc_fighter_media_assets from public, anon, authenticated;
revoke all on public.ufc_fighter_media_candidates from public, anon, authenticated;
revoke all on public.ufc_fighter_portrait_eligible from public, anon, authenticated;

grant select, insert, update on public.ufc_media_quarantine to service_role;
grant select, insert, update on public.ufc_fighter_media_assets to service_role;
grant select, insert, update, delete on public.ufc_fighter_media_candidates to service_role;
grant select on public.ufc_fighter_portrait_eligible to service_role;

revoke execute on function public.ufc_media_is_quarantined(text, text) from public, anon, authenticated;
revoke execute on function public.ufc_media_quarantine_image(text, text, uuid, text, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ufc_media_review_candidate(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.ufc_media_quarantine_asset(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ufc_media_touch_updated_at() from public, anon, authenticated;
revoke execute on function public.ufc_media_candidate_quarantine_guard() from public, anon, authenticated;
revoke execute on function public.ufc_media_asset_quarantine_guard() from public, anon, authenticated;
revoke execute on function public.ufc_media_quarantine_cascade() from public, anon, authenticated;

grant execute on function public.ufc_media_is_quarantined(text, text) to service_role;
grant execute on function public.ufc_media_quarantine_image(text, text, uuid, text, text, uuid, uuid) to service_role;
grant execute on function public.ufc_media_review_candidate(uuid, text, text, text, boolean) to service_role;
grant execute on function public.ufc_media_quarantine_asset(uuid, text, text) to service_role;

comment on table public.ufc_fighter_media_assets is
  'Reviewed fighter portraits. Only review_status=approved + verified_identity + is_primary rows can reach a public page, via ufc_fighter_portrait_eligible. Promotion happens through ufc_media_review_candidate().';
comment on table public.ufc_fighter_media_candidates is
  'Fighter portrait review queue (scripts/media/fighter_portrait_queue.mjs). Never read by a public page.';
comment on table public.ufc_media_quarantine is
  'Images that must never be used again, for any fighter. Matching candidates are forced to quarantined and matching assets cannot be approved.';

-- ---------------------------------------------------------------------------
-- 8. Carry over the one human quarantine decision that lived in code
-- ---------------------------------------------------------------------------
-- web/lib/verifiedPortraits.ts ESPN_DISPLAY_QUARANTINE, removed on this branch.
insert into public.ufc_media_quarantine (image_url, source_url, fighter_id, reason, quarantined_by)
select 'https://a.espncdn.com/i/headshots/mma/players/full/5307124.png',
       'https://www.espn.com/mma/fighter/_/id/5307124',
       (select f.id from public.ufc_fighters f where f.espn_athlete_id = '5307124' limit 1),
       'Wrong face observed on the ESPN display asset for athlete 5307124 (Quentin Pasley), 2026-09-10. Carried over from ESPN_DISPLAY_QUARANTINE in web/lib/verifiedPortraits.ts.',
       'migration:20260910210000'
where not exists (
  select 1 from public.ufc_media_quarantine q
   where q.lifted_at is null and q.image_key = 'https://a.espncdn.com/i/headshots/mma/players/full/5307124.png'
);

commit;

notify pgrst, 'reload schema';
