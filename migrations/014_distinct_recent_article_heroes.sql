-- Recent newsroom cards should not repeat the same fighter portrait over and
-- over. Keep a deliberate editorial media lock when present; otherwise rotate
-- to another rights-safe image of the central bout fighters, and fall back to
-- the branded two-fighter treatment when no unused real photo is available.
--
-- This is deliberately media-only. It never changes article copy, facts,
-- sourcing, odds, model output, or publication status.

create or replace function public.assign_distinct_article_hero()
returns trigger
language plpgsql
as $$
declare
  central_fighters uuid[] := array[]::uuid[];
  chosen public.ufc_images%rowtype;
  proposed_is_recent_duplicate boolean := false;
begin
  if new.status is distinct from 'published' then
    return new;
  end if;

  -- Explicit desk choice wins over automatic de-duplication.
  if lower(coalesce(new.hero_credit->>'media_lock', 'false')) = 'true' then
    return new;
  end if;

  if new.bout_id is not null then
    select array[b.fighter_a_id, b.fighter_b_id]::uuid[]
      into central_fighters
    from public.ufc_bouts b
    where b.id = new.bout_id;
  end if;

  if coalesce(cardinality(central_fighters), 0) = 0 then
    central_fighters := coalesce(new.fighter_ids[1:2], array[]::uuid[]);
  end if;

  if new.hero_image_ref is not null then
    select exists (
      select 1
      from (
        select a.hero_image_ref
        from public.ufc_articles a
        where a.status = 'published'
          and a.hero_image_ref is not null
          and a.id is distinct from new.id
        order by a.published_at desc nulls last, a.created_at desc
        limit 30
      ) recent
      where recent.hero_image_ref = new.hero_image_ref
    ) into proposed_is_recent_duplicate;
  end if;

  if new.hero_image_ref is not null and not proposed_is_recent_duplicate then
    return new;
  end if;

  if coalesce(cardinality(central_fighters), 0) > 0 then
    select i.*
      into chosen
    from public.ufc_images i
    where i.fighter_id = any(central_fighters)
      and i.kind in ('licensed_editorial', 'official_press', 'public_domain', 'wikimedia')
      and (i.rights_expires_at is null or i.rights_expires_at > now())
      and not exists (
        select 1
        from (
          select a.hero_image_ref
          from public.ufc_articles a
          where a.status = 'published'
            and a.hero_image_ref is not null
            and a.id is distinct from new.id
          order by a.published_at desc nulls last, a.created_at desc
          limit 30
        ) recent
        where recent.hero_image_ref = i.id::text
      )
    order by
      case i.kind
        when 'licensed_editorial' then 500
        when 'official_press' then 450
        when 'public_domain' then 400
        when 'wikimedia' then 350
        else 0
      end desc,
      i.created_at desc,
      i.id
    limit 1;
  end if;

  if chosen.id is not null then
    new.hero_image_ref := chosen.id::text;
    new.hero_credit := jsonb_strip_nulls(jsonb_build_object(
      'author', chosen.author,
      'license', chosen.license,
      'source_url', chosen.source_url,
      'auto_distinct', true
    ));
  else
    -- Repeating a portrait is worse than using the site's branded matchup
    -- treatment, which still renders the actual fighter identities/media.
    new.hero_image_ref := null;
    new.hero_credit := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_distinct_recent_article_heroes on public.ufc_articles;
create trigger trg_distinct_recent_article_heroes
before insert or update of status, hero_image_ref, hero_credit, fighter_ids, bout_id, published_at
on public.ufc_articles
for each row
execute function public.assign_distinct_article_hero();
