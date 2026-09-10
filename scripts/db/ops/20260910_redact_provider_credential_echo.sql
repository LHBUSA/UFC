-- Scrub a provider error body that echoed a credential prefix back into our
-- tables.
--
-- WHAT HAPPENED. A Stripe LIVE secret key (sk_live_...) was set as
-- ufc-news-enrich's OPENAI_API_KEY. Three editorial attempts sent it to
-- api.openai.com as a bearer token; OpenAI rejected it with a 401 whose body
-- quotes the key with all but the last four characters masked, and the pipeline
-- stored that body as a hold reason.
--
-- The fragment is not a usable secret - 8 visible prefix characters and 4
-- trailing ones out of a ~107-character key. But a credential fragment does not
-- belong in a table the whole team can read, and the key itself must be rotated
-- regardless because it was transmitted to a third party.
--
-- The permanent fix is in the code: provider error bodies are now redacted
-- before they are stored. This cleans up what already landed.
begin;

update public.ufc_news_items
   set state_reason = 'editorial provider rejected the configured credential (401); detail redacted because the provider error echoed part of the key'
 where state_reason like '%sk_live%'
    or state_reason like '%sk-proj-%'
    or state_reason like '%Incorrect API key provided%';

update public.ufc_news_pipeline_events
   set detail = jsonb_build_object(
         'error', 'editorial provider rejected the configured credential (401); detail redacted',
         'redacted_at', now(),
         'original_stage', detail -> 'stage')
 where detail::text like '%sk_live%'
    or detail::text like '%sk-proj-%'
    or detail::text like '%Incorrect API key provided%';

commit;
