-- Tests for migration 010, for an ISOLATED database only.
--
-- STATUS: NEVER RUN. The SQL enforcement in 010 is UNVERIFIED.
--
-- This matters and is easy to gloss over: the JavaScript tests in
-- scripts/store/reconcile_rules.test.mjs exercise a mirror of these rules,
-- not the rules themselves. They prove the client asks for the right
-- transition. They prove nothing about whether store_claim_slug actually
-- refuses an uncertain row, whether the partial unique index actually rejects
-- a duplicate provider_product_id, or whether two concurrent claims actually
-- serialise. Those are properties of Postgres executing this DDL, and the
-- only thing that can establish them is Postgres executing this DDL.
--
-- Until this file has been run against a throwaway database and passed, every
-- claim about SQL-level enforcement should be read as "intended", not
-- "verified".
--
-- How to run it, when a disposable database exists:
--
--   createdb store_provisioning_test
--   psql store_provisioning_test -f migrations/010_store_provisioning.sql
--   psql store_provisioning_test -v ON_ERROR_STOP=1 -f migrations/tests/010_store_provisioning.test.sql
--
-- Do NOT run it against the production project. It inserts, mutates and
-- deletes rows, and the platform's only Postgres is production.

\set ON_ERROR_STOP on
begin;

do $$
declare
  r store_provisioning;
  r2 store_provisioning;
  n integer;
begin
  ---------------------------------------------------------------------------
  -- claim: a fresh slug is claimable exactly once
  ---------------------------------------------------------------------------
  r := store_claim_slug('t-alpha', gen_random_uuid(), 'tester-a');
  assert r.slug = 't-alpha' and r.state = 'in_flight', 'a fresh slug must be claimable';

  r2 := store_claim_slug('t-alpha', gen_random_uuid(), 'tester-b');
  assert r2 is null, 'a live claim must not be claimable by a second caller';

  ---------------------------------------------------------------------------
  -- crash recovery: a stale claim is NOT claimable, only expirable
  ---------------------------------------------------------------------------
  update store_provisioning set claimed_at = now() - interval '2 hours' where slug = 't-alpha';

  r2 := store_claim_slug('t-alpha', gen_random_uuid(), 'tester-c');
  assert r2 is null, 'a STALE in_flight claim must still not be claimable — age is not evidence';

  perform store_expire_stale_claims(interval '10 minutes');
  select * into r from store_provisioning where slug = 't-alpha';
  assert r.state = 'uncertain', 'an abandoned claim must expire to uncertain';
  assert r.uncertain_since <= now() - interval '1 hour',
    'uncertain_since must come from the claim, not from the moment of expiry';
  assert r.attempt_id is null, 'expiring must release the attempt id';

  ---------------------------------------------------------------------------
  -- uncertain is never claimable
  ---------------------------------------------------------------------------
  r2 := store_claim_slug('t-alpha', gen_random_uuid(), 'tester-d');
  assert r2 is null, 'an uncertain row must never be claimable';

  ---------------------------------------------------------------------------
  -- absent observations must be independent
  ---------------------------------------------------------------------------
  r := store_record_absent('t-alpha', interval '2 minutes');
  assert r.absent_checks = 1, 'the first observation must count';

  r2 := store_record_absent('t-alpha', interval '2 minutes');
  assert r2 is null, 'a second observation moments later must NOT count';

  update store_provisioning set last_absent_check_at = now() - interval '5 minutes' where slug = 't-alpha';
  r := store_record_absent('t-alpha', interval '2 minutes');
  assert r.absent_checks = 2, 'a spaced observation must count';

  ---------------------------------------------------------------------------
  -- absence cannot be settled early, on either condition alone
  ---------------------------------------------------------------------------
  r := store_settle_absent('t-alpha', interval '15 minutes', 3);
  assert r is null, 'settling must refuse without enough observations';

  update store_provisioning set absent_checks = 5, uncertain_since = now() - interval '1 minute' where slug = 't-alpha';
  r := store_settle_absent('t-alpha', interval '15 minutes', 3);
  assert r is null, 'settling must refuse before the quarantine window elapses';

  update store_provisioning set uncertain_since = now() - interval '1 hour' where slug = 't-alpha';
  r := store_settle_absent('t-alpha', interval '15 minutes', 3);
  assert r.state = 'failed', 'both conditions met, the deliberate settle must succeed';

  -- and only then is it claimable again
  r2 := store_claim_slug('t-alpha', gen_random_uuid(), 'tester-e');
  assert r2.state = 'in_flight', 'a settled-absent row must be claimable';

  ---------------------------------------------------------------------------
  -- adoption: positive evidence is conclusive with no waiting
  ---------------------------------------------------------------------------
  r := store_adopt_existing('t-alpha', 12345, 'observed at the provider');
  assert r.state = 'created' and r.provider_product_id = 12345, 'adoption must record the observed id';
  assert r.attempt_id is null, 'adoption must release the claim';

  r2 := store_claim_slug('t-alpha', gen_random_uuid(), 'tester-f');
  assert r2 is null, 'a created row must never be claimable';

  ---------------------------------------------------------------------------
  -- the backstop that does not depend on the provider's external_id semantics
  ---------------------------------------------------------------------------
  r := store_claim_slug('t-beta', gen_random_uuid(), 'tester-g');
  begin
    perform store_adopt_existing('t-beta', 12345, 'same provider product as t-alpha');
    assert false, 'two slugs must not be able to claim one provider product id';
  exception when unique_violation then
    null;  -- expected
  end;

  ---------------------------------------------------------------------------
  -- constraints
  ---------------------------------------------------------------------------
  begin
    update store_provisioning set state = 'created', provider_product_id = null where slug = 't-beta';
    assert false, 'created without a provider_product_id must be rejected';
  exception when check_violation then
    null;
  end;

  begin
    update store_provisioning set state = 'uncertain', uncertain_since = null where slug = 't-beta';
    assert false, 'uncertain without uncertain_since must be rejected';
  exception when check_violation then
    null;
  end;

  select count(*) into n from store_provisioning where slug like 't-%';
  raise notice 'all assertions passed (% test rows)', n;
end $$;

rollback;  -- leave nothing behind, even in a throwaway database
