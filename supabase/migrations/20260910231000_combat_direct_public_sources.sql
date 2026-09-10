-- PropBetEdge UFC — direct public-source MMA policy reset.
--
-- We do not need paid downstream repackagers for facts that are available from
-- upstream public sources. Wikipedia/Wikidata are first-class direct sources;
-- commercial aggregation APIs are disabled for this lane unless we explicitly
-- decide otherwise later.
--
-- This migration changes only combat_sources policy rows. It does not fetch or
-- insert any fight data.

begin;

insert into public.combat_sources
  (source_key, source_name, source_kind, homepage_url, terms_url, license_name,
   access_mode, rights_state, redistribution_allowed, enabled, rights_note, reviewed_at)
values
  ('wikipedia_en',
   'English Wikipedia',
   'open_data',
   'https://en.wikipedia.org/',
   'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use',
   'CC BY-SA 4.0 / GFDL as applicable to page text',
   'approved_ingest',
   'approved',
   false,
   true,
   'Direct MediaWiki Action API source. Store normalized factual fields plus page/revision provenance; do not redistribute copied article prose or raw page payloads as a proprietary dataset.',
   now())
on conflict (source_key) do update set
  source_name = excluded.source_name,
  source_kind = excluded.source_kind,
  homepage_url = excluded.homepage_url,
  terms_url = excluded.terms_url,
  license_name = excluded.license_name,
  access_mode = excluded.access_mode,
  rights_state = excluded.rights_state,
  redistribution_allowed = excluded.redistribution_allowed,
  enabled = excluded.enabled,
  rights_note = excluded.rights_note,
  reviewed_at = excluded.reviewed_at,
  updated_at = now();

-- UFCalendar publicly describes itself as sourcing UFC data from UFCStats and
-- other promotion data from Wikipedia. It is therefore not an upstream source
-- for this product and is deliberately disabled.
update public.combat_sources
set access_mode = 'blocked',
    rights_state = 'prohibited',
    redistribution_allowed = false,
    enabled = false,
    rights_note = 'Not used. Downstream aggregation of sources PropBetEdge can ingest directly (UFCStats/Wikipedia).',
    reviewed_at = now(),
    updated_at = now()
where source_key = 'ufcalendar';

-- Current product direction: no paid data dependency for the direct MMA career
-- lane. These rows remain in the ledger so a future business decision can be
-- explicit rather than silently introducing a vendor dependency.
update public.combat_sources
set access_mode = 'blocked',
    rights_state = 'prohibited',
    redistribution_allowed = false,
    enabled = false,
    rights_note = 'Disabled for the direct-source strategy. Re-enable only through an explicit future source-policy migration.',
    reviewed_at = now(),
    updated_at = now()
where source_key in ('fight_forensics','sportsdataio','sportradar');

commit;
