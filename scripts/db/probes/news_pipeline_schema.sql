-- Schema probe for the real-time news pipeline migration.
--
-- Run it BEFORE and AFTER 20260909180000_ufc_news_pipeline.sql. Before, every
-- `present` is false and the counts are the pre-migration baseline; after, the
-- same query is the proof of exactly what changed. One query, two runs, no
-- separate "expected" list to drift out of date.
select json_build_object(
  'probed_at', now(),

  -- 1. The columns this migration adds, by table. A column that already exists
  --    under a different type is worse than a missing one, so type is carried.
  'new_columns', (
    select coalesce(json_object_agg(t.table_name, t.cols), '{}'::json)
    from (
      select c.table_name,
             json_agg(json_build_object('column', c.column_name, 'type', c.data_type, 'default', c.column_default)
                      order by c.column_name) as cols
      from information_schema.columns c
      where c.table_schema = 'public'
        and (
          (c.table_name = 'ufc_news_items' and c.column_name in (
            'state','state_reason','state_changed_at','relevance_score','relevance_reason','story_kind',
            'primary_fighter_id','secondary_fighter_ids','mentioned_fighter_ids','entity_confidence',
            'topic_signature','source_fetch_status','source_body','source_body_hash',
            'source_image_url','source_published_at','source_fetched_at','canonical_article_id',
            'detected_at','article_id','first_published_at','attempts','last_attempt_at',
            'lease_token','lease_expires_at'))
          or
          (c.table_name = 'ufc_articles' and c.column_name in (
            'relevance_score','primary_fighter_id','topic_signature','source_body_hash',
            'validation','hold_reason','canonical_article_id','superseded_by',
            'update_count','first_published_at','news_item_id'))
        )
      group by c.table_name
    ) t
  ),

  -- 2. The new table.
  'pipeline_events_table', (
    select coalesce(json_agg(json_build_object('column', column_name, 'type', data_type) order by ordinal_position), '[]'::json)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'ufc_news_pipeline_events'
  ),
  -- to_regclass, not a cast: a cast on a table that does not exist yet raises
  -- rather than returning null, and this query has to run BEFORE the migration.
  'pipeline_events_rls', (
    select coalesce((select relrowsecurity from pg_class
                     where oid = to_regclass('public.ufc_news_pipeline_events')), false)
  ),

  -- 3. Indexes this migration creates.
  'new_indexes', (
    select coalesce(json_agg(indexname order by indexname), '[]'::json)
    from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'ufc_news_items_state_idx',
        'ufc_news_items_pipeline_idx',
        'ufc_news_items_topic_sig_idx',
        'ufc_news_items_primary_fighter_idx',
        'ufc_news_items_source_body_hash_idx',
        'ufc_articles_topic_sig_idx',
        'ufc_articles_primary_fighter_idx',
        'ufc_articles_source_body_hash_idx',
        'ufc_news_pipeline_events_item_idx',
        'ufc_news_pipeline_events_stage_idx',
        'ufc_news_pipeline_events_at_idx',
        'ufc_articles_news_item_uniq'
      )
  ),

  -- The one-article-per-item guarantee, stated as the index definition rather
  -- than as a name, so a partial index quietly losing its WHERE clause shows up.
  'news_item_uniq_def', (
    select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'ufc_articles_news_item_uniq'
  ),

  -- New CHECK constraints, by definition.
  'news_items_check_constraints', (
    select coalesce(json_object_agg(conname, pg_get_constraintdef(oid)), '{}'::json)
    from pg_constraint
    where conrelid = 'public.ufc_news_items'::regclass and contype = 'c'
  ),

  -- 4. What must NOT change. These are the load-bearing facts of the current
  --    system: the status enum the site and API filter on, the two unique
  --    constraints that make a duplicate row unconstructible, the hero trigger,
  --    and the published-article count the public actually sees.
  'articles_check_constraints', (
    select coalesce(json_object_agg(conname, pg_get_constraintdef(oid)), '{}'::json)
    from pg_constraint
    where conrelid = 'public.ufc_articles'::regclass and contype = 'c'
  ),
  'news_items_unique', (
    select coalesce(json_agg(conname order by conname), '[]'::json)
    from pg_constraint
    where conrelid = 'public.ufc_news_items'::regclass and contype = 'u'
  ),
  'articles_unique', (
    select coalesce(json_agg(conname order by conname), '[]'::json)
    from pg_constraint
    where conrelid = 'public.ufc_articles'::regclass and contype = 'u'
  ),
  'hero_trigger_present', (
    select exists (select 1 from pg_proc where proname = 'assign_distinct_article_hero')
  ),

  -- 5. Row counts. The article counts are the public-behaviour baseline.
  'counts', json_build_object(
    'news_items', (select count(*) from public.ufc_news_items),
    'articles_total', (select count(*) from public.ufc_articles),
    'articles_published', (select count(*) from public.ufc_articles where status = 'published'),
    'articles_review', (select count(*) from public.ufc_articles where status = 'review'),
    'articles_draft', (select count(*) from public.ufc_articles where status = 'draft')
  ),

  -- 6. Backfill target distribution: how the state column will be seeded.
  --    Read through to_jsonb rather than naming the column, so the identical
  --    query runs before the column exists (it reads as null) and after.
  'state_distribution', (
    select coalesce(json_object_agg(k, v), '{}'::json) from (
      select coalesce(to_jsonb(n) ->> 'state', '(no such column)') as k, count(*) as v
      from public.ufc_news_items n
      group by 1
    ) s
  )
) as probe;
