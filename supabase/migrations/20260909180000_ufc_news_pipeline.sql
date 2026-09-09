-- Real-time UFC news pipeline: candidate state machine, entity resolution,
-- source provenance, dedupe keys and stage telemetry.
--
-- ADDITIVE ONLY. This migration creates columns, one table and indexes. It
-- drops nothing, renames nothing, rewrites no existing row's meaning, and
-- changes no constraint the running system depends on. In particular:
--
--   * ufc_articles.status keeps its three values. The site
--     (web/lib/db.ts) and the API (workers/ufc-api) both filter
--     status = 'published' and neither learns a new value here. A held
--     article is status='review' with a hold_reason, which is what they
--     already treat as private. Widening a CHECK constraint on a live table
--     to add 'held' would have been a change to the one control that keeps
--     thin drafts off the site, for no gain.
--   * ufc_news_items.url and .fingerprint keep their unique constraints.
--     Those are what make a duplicate ROW unconstructible and they are
--     load-bearing for the ingest worker's check-then-insert.
--   * assign_distinct_article_hero() is untouched.
--
-- Nothing here is read by any deployed Worker, the API or the website. It is
-- inert until the ingest and enrich workers ship.
--
-- WHY THIS FILE IS ONLY UNDER supabase/migrations
--
-- The root migrations/ directory is the older hand-numbered ledger and its
-- numbers have already collided across branches four times (see
-- scripts/db/check_migration_ledger.mjs). supabase/migrations is the ledger the
-- apply tooling addresses by path, so new work goes there and only there.
--
-- ON CONCURRENCY, WHICH IS THE POINT OF THE state COLUMN
--
-- The real-time path takes per-item work out from under the newsroom's global
-- 20-minute Durable Object lock. What replaces it is not "nothing": it is a
-- state machine advanced by conditional single-statement UPDATEs. Claiming an
-- item is
--
--   update ufc_news_items set state='enriching', lease_token=..., attempts=attempts+1
--   where id = $1 and state = 'queued'
--
-- which is atomic in Postgres, so a duplicate queue delivery updates zero rows
-- and the second consumer stops. Publication is guarded a second time and
-- structurally: ufc_articles_news_item_uniq permits at most one article per
-- news item, so even a consumer that somehow got past the state check cannot
-- create a second public row. lease_token lets a consumer prove at publish time
-- that it still owns the item it claimed, closing the window where a stalled
-- run is reclaimed on lease expiry and then wakes up.

begin;

-- ---------------------------------------------------------------------------
-- 1. ufc_news_items: the candidate state machine and everything the enricher
--    needs to decide, resolve, fetch and dedupe without re-reading the wire.
-- ---------------------------------------------------------------------------
alter table public.ufc_news_items
  add column if not exists state              text not null default 'new',
  add column if not exists state_reason       text,
  add column if not exists state_changed_at   timestamptz not null default now(),

  -- Relevance, scored once per item. 1-5, PropBetEdge scale.
  add column if not exists relevance_score    int,
  add column if not exists relevance_reason   text,
  add column if not exists story_kind         text,

  -- Entity resolution. A comparison subject is not the subject: the three
  -- arrays exist so "Jon Jones" appearing in a prospect's signing headline
  -- lands in mentioned_fighter_ids and never becomes the hero image.
  add column if not exists primary_fighter_id uuid references public.ufc_fighters(id),
  add column if not exists secondary_fighter_ids uuid[] not null default '{}',
  add column if not exists mentioned_fighter_ids uuid[] not null default '{}',
  add column if not exists entity_confidence  numeric,

  -- Source provenance. source_body is research material for the editorial
  -- stage and the input to the Class-B number gate; it is never served.
  add column if not exists source_fetch_status text,
  add column if not exists source_body        text,
  add column if not exists source_body_hash   text,
  add column if not exists source_image_url   text,
  add column if not exists source_published_at timestamptz,
  add column if not exists source_fetched_at  timestamptz,

  -- Dedupe and canonical-topic linkage.
  add column if not exists topic_signature    text,
  add column if not exists canonical_article_id uuid references public.ufc_articles(id),

  -- The article this item produced, and the latency clock.
  add column if not exists article_id         uuid references public.ufc_articles(id),
  add column if not exists detected_at        timestamptz not null default now(),
  add column if not exists first_published_at timestamptz,

  -- Bounded retries and the per-item lease.
  add column if not exists attempts           int not null default 0,
  add column if not exists last_attempt_at    timestamptz,
  add column if not exists lease_token        uuid,
  add column if not exists lease_expires_at   timestamptz;

comment on column public.ufc_news_items.state is
  'Candidate state machine. new -> scored -> queued -> enriching -> published | held | skipped | duplicate | failed. Advanced only by conditional UPDATE, which is what makes a duplicate queue delivery a no-op.';
comment on column public.ufc_news_items.source_body is
  'Extracted text of the fetched source page. Research input only: never served by the API or the site, and the two-class number gate treats its numbers as Class B (attribution required).';
comment on column public.ufc_news_items.primary_fighter_id is
  'The subject of the story, not merely a fighter named in it. Hero image selection reads this column and no other.';
comment on column public.ufc_news_items.detected_at is
  'When this item entered our system. The start of the detection-to-publish SLA clock; backfilled from captured_at for pre-existing rows.';

-- States are a closed set. Named so a bad write fails at the database rather
-- than becoming an item that no consumer will ever pick up again.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ufc_news_items_state_check') then
    alter table public.ufc_news_items
      add constraint ufc_news_items_state_check check (state in (
        'new','scored','queued','enriching','published','held','skipped','duplicate','failed'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ufc_news_items_relevance_check') then
    alter table public.ufc_news_items
      add constraint ufc_news_items_relevance_check
      check (relevance_score is null or relevance_score between 1 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ufc_news_items_fetch_status_check') then
    alter table public.ufc_news_items
      add constraint ufc_news_items_fetch_status_check check (source_fetch_status is null or source_fetch_status in (
        'ok','thin','failed','blocked','skipped','not_attempted'
      ));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. ufc_articles: provenance back to the item, the validator verdict, and the
--    canonical-topic fields that make "update the story" possible instead of
--    "publish a fifth near-duplicate".
-- ---------------------------------------------------------------------------
alter table public.ufc_articles
  add column if not exists news_item_id       uuid references public.ufc_news_items(id),
  add column if not exists relevance_score    int,
  add column if not exists primary_fighter_id uuid references public.ufc_fighters(id),
  add column if not exists topic_signature    text,
  add column if not exists source_body_hash   text,

  -- Every gate's verdict for this article, so a published story can prove what
  -- passed and a held one can say what failed without reading logs.
  add column if not exists validation         jsonb not null default '{}'::jsonb,
  add column if not exists hold_reason        text,

  -- Canonical topic. canonical_article_id points at the story this one belongs
  -- to; superseded_by points at the story that replaced it.
  add column if not exists canonical_article_id uuid references public.ufc_articles(id),
  add column if not exists superseded_by      uuid references public.ufc_articles(id),
  add column if not exists update_count       int not null default 0,
  add column if not exists first_published_at timestamptz;

comment on column public.ufc_articles.news_item_id is
  'The wire item that triggered this article. Uniquely indexed where not null: one item can produce at most one article, which is the structural half of duplicate-delivery safety.';
comment on column public.ufc_articles.validation is
  'Per-gate verdicts from the deterministic publication gate. Written on every attempt, published or held.';
comment on column public.ufc_articles.hold_reason is
  'Why this article is not public. Set alongside status=''review''; the status enum is deliberately unchanged so the site and API need no new knowledge to keep it private.';
comment on column public.ufc_articles.first_published_at is
  'First time this article became public, never rewritten by a later refresh. published_at moves on a material update; this does not, so the SLA measurement stays honest.';

-- One article per wire item. This is the constraint that makes a duplicate
-- public article unconstructible rather than merely unlikely.
create unique index if not exists ufc_articles_news_item_uniq
  on public.ufc_articles (news_item_id) where news_item_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Stage telemetry. This table is the SLA instrument and the acceptance-test
--    evidence trail: it is how "detected to publish, p50/p95/max" is answered
--    with measurement instead of cron arithmetic, and how we prove no article
--    was ever public before its editorial and validation stages succeeded.
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_news_pipeline_events (
  id              bigint generated always as identity primary key,
  news_item_id    uuid references public.ufc_news_items(id) on delete cascade,
  article_id      uuid references public.ufc_articles(id) on delete set null,
  stage           text not null check (stage in (
                    'detect','score','resolve','fetch','packet','editorial',
                    'validate','dedupe','media','publish','hold','skip','error'
                  )),
  status          text not null check (status in ('ok','held','skipped','failed')),
  latency_ms      int,          -- this stage alone
  since_detect_ms int,          -- cumulative from ufc_news_items.detected_at
  worker          text,
  detail          jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now()
);

comment on table public.ufc_news_pipeline_events is
  'One row per pipeline stage per news item. since_detect_ms on the publish row is the detection-to-publish latency the SLA is measured from.';

create index if not exists ufc_news_pipeline_events_item_idx
  on public.ufc_news_pipeline_events (news_item_id, at);
create index if not exists ufc_news_pipeline_events_stage_idx
  on public.ufc_news_pipeline_events (stage, at desc);
create index if not exists ufc_news_pipeline_events_at_idx
  on public.ufc_news_pipeline_events (at desc);

-- Service-role writes only, matching every other ufc_* table. No policy is
-- created, so the anon key can neither read nor write this table.
alter table public.ufc_news_pipeline_events enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Indexes for the paths the workers actually take.
-- ---------------------------------------------------------------------------

-- The claim query: "oldest scored item not yet queued", and the reclaim query
-- "enriching, lease expired". Partial, because settled items are the majority
-- and never appear in either.
create index if not exists ufc_news_items_pipeline_idx
  on public.ufc_news_items (state, detected_at)
  where state in ('new','scored','queued','enriching');

create index if not exists ufc_news_items_state_idx
  on public.ufc_news_items (state);

create index if not exists ufc_news_items_topic_sig_idx
  on public.ufc_news_items (topic_signature)
  where topic_signature is not null;

create index if not exists ufc_news_items_primary_fighter_idx
  on public.ufc_news_items (primary_fighter_id)
  where primary_fighter_id is not null;

create index if not exists ufc_news_items_source_body_hash_idx
  on public.ufc_news_items (source_body_hash)
  where source_body_hash is not null;

-- Article-side dedupe lookups: canonical-topic collision within a window, and
-- source-body-hash duplicate detection.
create index if not exists ufc_articles_topic_sig_idx
  on public.ufc_articles (topic_signature, published_at desc)
  where topic_signature is not null;

create index if not exists ufc_articles_primary_fighter_idx
  on public.ufc_articles (primary_fighter_id)
  where primary_fighter_id is not null;

create index if not exists ufc_articles_source_body_hash_idx
  on public.ufc_articles (source_body_hash)
  where source_body_hash is not null;

-- ---------------------------------------------------------------------------
-- 5. Backfill. Two writes, both filling a column that was null a moment ago;
--    neither changes anything any reader can see today.
-- ---------------------------------------------------------------------------

-- detected_at defaulted to now() for the 140 rows that already existed, which
-- would make every one of them look as though it arrived at migration time and
-- corrupt the first latency report. captured_at is when they actually arrived.
update public.ufc_news_items
   set detected_at = captured_at
 where captured_at is not null
   and detected_at > captured_at;

-- Existing items are historical, not candidates: seeding them as 'new' would
-- hand the enricher a 140-item backlog of stale wire on its first run. They
-- are marked 'skipped' with a reason, and Phase 8 reprocesses the ones worth
-- reprocessing deliberately rather than by accident.
update public.ufc_news_items
   set state = 'skipped',
       state_reason = 'pre_pipeline_backlog: ingested before the real-time pipeline; reprocessed deliberately in the backlog phase, never automatically',
       state_changed_at = now()
 where state = 'new';

-- Articles already public have a first_published_at: their current
-- published_at. Later refreshes move published_at; this must not move.
update public.ufc_articles
   set first_published_at = published_at
 where published_at is not null
   and first_published_at is null;

commit;
