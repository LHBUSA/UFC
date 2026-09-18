-- Rule proof for 20260918120000_ufc_bouts_effective (migrations/031).
--
-- Pure SQL, no psql meta-commands: it must run AFTER the migration body, inside ONE transaction
-- that is ROLLED BACK. Every row it writes is a new fixture row (espn ids prefixed 't031-'); it
-- never reads or touches an existing row, and nothing survives the rollback.
--
--   isolated db : psql -v ON_ERROR_STOP=1 -c 'begin' -f migrations/031_ufc_bouts_effective.sql -f <this file> -c 'rollback'
--   this repo   : scripts/db/prove_bouts_effective.ps1   (BEGIN; migration; this file; ROLLBACK through the Management API)
--
-- Each case mirrors a case in web/lib/cardTruth.test.ts. A failed assertion raises and aborts.

do $$
declare
  f uuid[] := array(select gen_random_uuid() from generate_series(1, 26));
  e1 uuid := gen_random_uuid(); e2 uuid := gen_random_uuid(); e3 uuid := gen_random_uuid(); e4 uuid := gen_random_uuid();
  b uuid[] := array(select gen_random_uuid() from generate_series(1, 13));
  r record;
  t1 timestamptz := '2031-01-01T00:00:00Z'; t2 timestamptz := '2031-01-02T00:00:00Z'; t3 timestamptz := '2031-01-03T00:00:00Z';
begin
  insert into public.ufc_fighters (id, name, espn_athlete_id, source_url)
    select f[i], 'T031 Fighter ' || i, 't031-f' || i, 'https://example.test/f' from generate_series(1, 26) i;
  insert into public.ufc_events (id, name, espn_event_id, event_date, source_url) values
    (e1, 'T031 Card One', 't031-e1', '2031-02-01', 'https://example.test/e1'),
    (e2, 'T031 Incomplete Read', 't031-e2', '2031-02-08', 'https://example.test/e2'),
    (e3, 'T031 Fought Card', 't031-e3', '2030-12-01', 'https://example.test/e3'),
    (e4, 'T031 Never Observed', 't031-e4', '2031-02-15', 'https://example.test/e4');

  insert into public.ufc_bouts (id, event_id, espn_competition_id, fighter_a_id, fighter_b_id, bout_order, status, source_url) values
    (b[1],  e1, 't031-c1',  f[1],  f[2],  13, 'announced', 'https://example.test/b'),  -- listed
    (b[2],  e1, 't031-c2',  f[3],  f[4],  12, 'announced', 'https://example.test/b'),  -- missing + withdrawal + injury
    (b[3],  e1, 't031-c3',  f[5],  f[6],  11, 'announced', 'https://example.test/b'),  -- listed + withdrawal reported
    (b[4],  e1, 't031-c4',  f[7],  f[8],  10, 'announced', 'https://example.test/b'),  -- placeholder
    (b[5],  e1, null,       f[9],  f[10],  9, 'announced', 'https://example.test/b'),  -- no source id
    (b[6],  e1, 't031-c6',  f[11], f[12],  8, 'cancelled', 'https://example.test/b'),  -- stored cancelled, still listed
    (b[7],  e2, 't031-c7',  f[13], f[14],  5, 'announced', 'https://example.test/b'),  -- newest read incomplete
    (b[8],  e3, 't031-c8',  f[15], f[16],  5, 'complete',  'https://example.test/b'),  -- fought (status)
    (b[9],  e3, 't031-c9',  f[17], f[18],  4, 'announced', 'https://example.test/b'),  -- fought (result row)
    (b[10], e4, 't031-c10', f[19], f[20],  5, 'announced', 'https://example.test/b'),  -- never observed
    (b[11], e1, 't031-c11', f[21], f[22],  7, 'announced', 'https://example.test/b'),  -- missing, no report at all
    (b[12], e1, 't031-c12', f[23], f[24],  6, 'announced', 'https://example.test/b'),  -- missing, sources disagree on cause
    (b[13], e1, 't031-c13', f[25], f[26],  5, 'confirmed', 'https://example.test/b');  -- listed, stored confirmed
  insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, source_url)
    values (b[9], f[17], 'DEC_U', 'Decision - Unanimous', 'https://example.test/r');

  -- e1: t1 lists everything; t2 and t3 (newest) drop c2, c11, c12; c4 is a placeholder throughout
  insert into public.ufc_event_card_observations (event_id, source, observed_at, competition_ids, placeholder_ids, complete, writer) values
    (e1, 'espn', t1, array['t031-c1','t031-c2','t031-c3','t031-c6','t031-c11','t031-c12','t031-c13'], array['t031-c4'], true, 't031'),
    (e1, 'espn', t2, array['t031-c1','t031-c3','t031-c6','t031-c13'], array['t031-c4'], true, 't031'),
    (e1, 'espn', t3, array['t031-c1','t031-c3','t031-c6','t031-c13'], array['t031-c4'], true, 't031'),
    -- e2: an older COMPLETE read without c7, then a newer INCOMPLETE read: the newest read decides, and it is ambiguous
    (e2, 'espn', t1, array['t031-zz'], '{}', true, 't031'),
    (e2, 'espn', t2, '{}', '{}', false, 't031'),
    -- e3: a complete read of an old card that lists neither fought bout
    (e3, 'espn', t3, array['t031-zz'], '{}', true, 't031');

  insert into public.ufc_fighter_status_events (fighter_id, status_type, state, event_id, bout_id, source_url, source_name, source_kind, source_published_at, confidence, fingerprint) values
    (f[3],  'withdrawal', 'active', e1, null, 'https://news.test/ortega-out?utm=1', 'News A', 'news', '2031-01-01T12:00:00Z', 0.9, 't031-1'),
    (f[3],  'withdrawal', 'active', e1, b[2], 'https://news.test/ortega-out#top',   'News A', 'news', '2031-01-01T18:00:00Z', 0.9, 't031-2'),
    (f[3],  'injury',     'active', e1, null, 'https://news.test/ortega-injury',    'News B', 'news', '2031-01-01T13:00:00Z', 0.9, 't031-3'),
    (f[5],  'withdrawal', 'active', e1, null, 'https://news.test/pico-out',         'News A', 'news', '2031-01-02T12:00:00Z', 0.9, 't031-4'),
    (f[23], 'withdrawal', 'active', e1, null, 'https://news.test/x-out',            'News A', 'news', '2031-01-02T12:00:00Z', 0.9, 't031-5'),
    (f[23], 'injury',     'active', e1, null, 'https://news.test/x-injury',         'News A', 'news', '2031-01-02T12:00:00Z', 0.9, 't031-6'),
    (f[23], 'illness',    'active', e1, null, 'https://news.test/x-illness',        'News B', 'news', '2031-01-02T12:00:00Z', 0.9, 't031-7'),
    -- another card's injury for a listed fighter must not leak onto this card
    (f[1],  'injury',     'active', e4, null, 'https://news.test/other-card',       'News A', 'news', '2031-01-02T12:00:00Z', 0.9, 't031-8'),
    -- a withdrawal about a fought bout is history
    (f[15], 'withdrawal', 'active', e3, null, 'https://news.test/old',              'News A', 'news', '2030-11-02T12:00:00Z', 0.9, 't031-9');

  -- 1. listed bout: active, present, no evidence, other card's injury does not leak
  select * into r from public.ufc_bouts_effective where id = b[1];
  assert r.is_active and r.effective_status = 'announced' and r.official_card_present is true and r.removal_basis is null
     and r.reason is null and r.source_receipt_count = 0 and not r.withdrawal_reported, 'case 1 listed';

  -- 2. Moicano-Ortega shape: confirmed removal, withdrawal contributes, reason sourced, dated, receipts de-duplicated
  select * into r from public.ufc_bouts_effective where id = b[2];
  assert not r.is_active and r.stored_status = 'announced' and r.effective_status = 'cancelled', 'case 2 status';
  assert r.removal_basis = array['card_observation','withdrawal'], 'case 2 basis ' || r.removal_basis::text;
  assert r.official_card_present is false and r.off_card_since = t2, 'case 2 since ' || coalesce(r.off_card_since::text, 'null');
  assert r.reason = 'injury' and r.withdrawn_fighter_id = f[3] and r.source_receipt_count = 2, 'case 2 reason/receipts ' || r.source_receipt_count;
  assert r.removal_reported_at = '2031-01-01T12:00:00Z'::timestamptz and not r.withdrawal_reported, 'case 2 reported_at';

  -- 3. Allen-Pico shape: reported withdrawal, official card still lists it => ACTIVE with a warning, reason never invented
  select * into r from public.ufc_bouts_effective where id = b[3];
  assert r.is_active and r.effective_status = 'announced' and r.removal_basis is null, 'case 3 stays active';
  assert r.withdrawal_reported and r.official_card_present is true and r.reason is null and r.withdrawn_fighter_id = f[5]
     and r.source_receipt_count = 1 and r.removal_reported_at is not null, 'case 3 warning';

  -- 4-5, 7, 10. every ambiguous official read removes nobody, and says NULL rather than false
  for r in select * from public.ufc_bouts_effective where id in (b[4], b[5], b[7], b[10]) loop
    assert r.is_active and r.effective_status = 'announced' and r.official_card_present is null and r.removal_basis is null and r.off_card_since is null,
      'ambiguous read removed a bout: ' || r.official_card_state;
  end loop;
  assert (select official_card_state from public.ufc_bouts_effective where id = b[4]) = 'placeholder', 'case 4';
  assert (select official_card_state from public.ufc_bouts_effective where id = b[5]) = 'no_source_id', 'case 5';
  assert (select official_card_state from public.ufc_bouts_effective where id = b[7]) = 'incomplete', 'case 7';
  assert (select official_card_state from public.ufc_bouts_effective where id = b[10]) = 'unobserved', 'case 10';

  -- 6. stored cancelled stays cancelled even though the card lists it; the stored word is kept
  select * into r from public.ufc_bouts_effective where id = b[6];
  assert not r.is_active and r.effective_status = 'cancelled' and r.removal_basis = array['status'], 'case 6';

  -- 8-9. fought bouts are history: never removed, no evidence columns, whatever a later read or report says
  for r in select * from public.ufc_bouts_effective where id in (b[8], b[9]) loop
    assert r.is_active and r.is_settled and r.effective_status = r.stored_status and r.removal_basis is null
       and not r.withdrawal_reported and r.removal_reported_at is null and r.source_receipt_count = 0 and r.off_card_since is null, 'fought bout touched';
  end loop;

  -- 11. removed with no report at all: no reason, no receipts, nothing invented
  select * into r from public.ufc_bouts_effective where id = b[11];
  assert not r.is_active and r.removal_basis = array['card_observation'] and r.reason is null and r.withdrawn_fighter_id is null
     and r.source_receipt_count = 0 and r.removal_reported_at is null, 'case 11';

  -- 12. sources disagree on the cause: no reason
  select * into r from public.ufc_bouts_effective where id = b[12];
  assert not r.is_active and r.reason is null and r.source_receipt_count = 3, 'case 12';

  -- 13. stored confirmed + listed
  select * into r from public.ufc_bouts_effective where id = b[13];
  assert r.is_active and r.effective_status = 'confirmed', 'case 13';

  -- the view is exactly ufc_bouts: one row per bout, none added, none lost
  assert (select count(*) from public.ufc_bouts_effective) = (select count(*) from public.ufc_bouts), 'row count differs from ufc_bouts';
  assert (select count(*) from public.ufc_bouts_effective where event_id = e1 and is_active) = 5, 'e1 active count';

  -- posture: not readable by anon / authenticated, no bare status column
  assert not has_table_privilege('anon', 'public.ufc_bouts_effective', 'select'), 'anon can read';
  assert not has_table_privilege('authenticated', 'public.ufc_bouts_effective', 'select'), 'authenticated can read';
  assert has_table_privilege('service_role', 'public.ufc_bouts_effective', 'select'), 'service_role cannot read';
  assert not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ufc_bouts_effective' and column_name = 'status'), 'bare status column';
end $$;

select 'ufc_bouts_effective: all rule cases PASS' as result;
