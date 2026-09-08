-- Schema tests for 012_store_orders.sql.
--
--   psql -d <disposable> -v ON_ERROR_STOP=1 -f migrations/012_store_orders.sql
--   psql -d <disposable> -v ON_ERROR_STOP=1 -f migrations/tests/012_store_orders.test.sql
--
-- Runs inside a transaction and rolls back, so it leaves nothing behind. It
-- asserts the properties the application relies on but cannot enforce: that
-- Postgres itself refuses the wrong transition. A test that only proves the
-- client asks correctly proves nothing about a second client.
--
-- Never point this at a database with real orders in it.

begin;

do $$
declare
  o        store_orders;
  o2       store_orders;
  att      uuid := gen_random_uuid();
  att2     uuid := gen_random_uuid();
  n        integer;
begin
  -- A pending order, as the checkout route would create it.
  insert into store_orders (public_token, stripe_session_id, external_id, state)
  values ('tok_test_1', 'cs_test_1', 'pbe-test-1', 'pending')
  returning * into o;

  insert into store_order_lines (order_id, slug, size, color, quantity, unit_price_cents, provider_variant_id)
  values (o.id, 'propbetedge-logo-tee', 'M', 'Black', 1, 3200, 4012);

  ---------------------------------------------------------------------------
  -- One line per variant, so a duplicate cannot hide a quantity.
  ---------------------------------------------------------------------------
  begin
    insert into store_order_lines (order_id, slug, size, color, quantity, unit_price_cents)
    values (o.id, 'propbetedge-logo-tee', 'M', 'Black', 1, 3200);
    raise exception 'a duplicate (order, slug, size, colour) line was accepted';
  exception when unique_violation then null;
  end;

  ---------------------------------------------------------------------------
  -- A free or negative line price is refused. A zero here is a bug that ships
  -- product for nothing.
  ---------------------------------------------------------------------------
  begin
    insert into store_order_lines (order_id, slug, size, color, quantity, unit_price_cents)
    values (o.id, 'propbetedge-mug', '11 oz', 'White', 1, 0);
    raise exception 'a zero unit price was accepted';
  exception when check_violation then null;
  end;

  ---------------------------------------------------------------------------
  -- An unpaid order cannot be claimed for fulfilment. This is the constraint
  -- that stops an application bug shipping goods nobody paid for.
  ---------------------------------------------------------------------------
  select * into o2 from store_order_claim(o.id, att, 'test');
  if o2.id is not null then
    raise exception 'a pending order was claimable for submission';
  end if;

  ---------------------------------------------------------------------------
  -- Payment is idempotent on the session id.
  ---------------------------------------------------------------------------
  select * into o2 from store_order_mark_paid(
    'cs_test_1', 'pi_test_1', 3899, 599, 100, 'buyer@example.com',
    '{"name":"A Buyer","line1":"1 Test St","city":"Austin","state":"TX","postal_code":"78701","country":"US"}'::jsonb);
  if o2.state <> 'paid' then raise exception 'first payment did not mark paid'; end if;
  if o2.amount_total_cents <> 3899 then raise exception 'total not recorded'; end if;
  if o2.ship_country <> 'US' then raise exception 'shipping address not recorded'; end if;

  -- A replay updates nothing and returns no row. The caller answers 200.
  select * into o2 from store_order_mark_paid(
    'cs_test_1', 'pi_test_1', 999999, 0, 0, 'attacker@example.com', '{}'::jsonb);
  if o2.id is not null then raise exception 'a replayed webhook re-applied payment'; end if;

  select amount_total_cents, email into n, o2.email from store_orders where id = o.id;
  if n <> 3899 then raise exception 'a replay overwrote the recorded total'; end if;

  ---------------------------------------------------------------------------
  -- Claiming, and the rule that a stale claim is never re-claimable.
  ---------------------------------------------------------------------------
  select * into o2 from store_order_claim(o.id, att, 'worker-a');
  if o2.state <> 'submitting' then raise exception 'a paid order was not claimable'; end if;
  if o2.submit_attempts <> 1 then raise exception 'attempt not counted'; end if;

  -- A second worker must not get the same order while it is in flight.
  select * into o2 from store_order_claim(o.id, att2, 'worker-b');
  if o2.id is not null then raise exception 'two workers claimed one order'; end if;

  -- A caller that lost its claim cannot settle the row.
  select * into o2 from store_order_mark_submitted(o.id, att2, 991);
  if o2.id is not null then raise exception 'a stale attempt_id settled the order'; end if;

  ---------------------------------------------------------------------------
  -- An abandoned claim becomes uncertain, and uncertain is NOT claimable.
  ---------------------------------------------------------------------------
  update store_orders set claimed_at = now() - interval '2 hours' where id = o.id;
  perform store_order_expire_stale_claims(interval '10 minutes');
  select * into o2 from store_orders where id = o.id;
  if o2.state <> 'submit_uncertain' then raise exception 'an abandoned claim did not expire to uncertain'; end if;
  if o2.uncertain_since is null then raise exception 'uncertain_since was not set'; end if;
  if o2.uncertain_since > now() - interval '1 hour' then
    raise exception 'uncertain_since was taken from the moment we noticed, not from the claim';
  end if;

  -- The whole point: an unobserved submission is never retried.
  select * into o2 from store_order_claim(o.id, att2, 'worker-c');
  if o2.id is not null then raise exception 'an uncertain order was handed back for another submission'; end if;

  ---------------------------------------------------------------------------
  -- Positive evidence settles it. One provider order under our external_id
  -- means it exists, so we adopt rather than submit again.
  ---------------------------------------------------------------------------
  select * into o2 from store_order_adopt_existing(o.id, 4242);
  if o2.state <> 'submitted' then raise exception 'adoption did not settle the order'; end if;
  if o2.provider_order_id <> 4242 then raise exception 'adopted the wrong provider order'; end if;
  if o2.uncertain_since is not null then raise exception 'uncertainty was not cleared on adoption'; end if;

  ---------------------------------------------------------------------------
  -- The provider must not hold two of our orders under one id.
  ---------------------------------------------------------------------------
  insert into store_orders (public_token, stripe_session_id, external_id, state, amount_total_cents)
  values ('tok_test_2', 'cs_test_2', 'pbe-test-2', 'paid', 1900) returning * into o2;
  begin
    update store_orders set provider_order_id = 4242 where id = o2.id;
    raise exception 'two orders were allowed to point at one provider order';
  exception when unique_violation then null;
  end;

  ---------------------------------------------------------------------------
  -- Session id and external id are unique, or idempotency is a fiction.
  ---------------------------------------------------------------------------
  begin
    insert into store_orders (public_token, stripe_session_id, external_id)
    values ('tok_test_3', 'cs_test_1', 'pbe-test-3');
    raise exception 'a duplicate stripe_session_id was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into store_orders (public_token, stripe_session_id, external_id)
    values ('tok_test_4', 'cs_test_4', 'pbe-test-1');
    raise exception 'a duplicate external_id was accepted';
  exception when unique_violation then null;
  end;

  ---------------------------------------------------------------------------
  -- A submitted order must point at something.
  ---------------------------------------------------------------------------
  begin
    update store_orders set state = 'submitted', provider_order_id = null where id = o2.id;
    raise exception 'a submitted order with no provider id was accepted';
  exception when check_violation then null;
  end;

  -- Lines vanish with their order rather than outliving it.
  select count(*) into n from store_order_lines where order_id = o.id;
  if n <> 1 then raise exception 'expected one surviving line, found %', n; end if;
  delete from store_orders where id = o.id;
  select count(*) into n from store_order_lines where order_id = o.id;
  if n <> 0 then raise exception 'order lines outlived their order'; end if;

  raise notice 'all assertions passed';
end $$;

rollback;
