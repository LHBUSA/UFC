-- PropBetEdge UFC — 008: automatically stamp rights on open-license media
--
-- 007 classified the existing catalog. This trigger makes the rule durable so
-- every future Wikimedia/public-domain insert receives the same commercial,
-- derivative and API-redistribution capabilities immediately.

begin;

create or replace function public.ufc_apply_open_media_rights()
returns trigger
language plpgsql
as $$
begin
  if new.kind in ('wikimedia', 'public_domain') and (
    lower(coalesce(new.license, '')) ~ '^cc0([[:space:]]*1\.0)?$'
    or lower(coalesce(new.license, '')) ~ '^public domain'
    or lower(coalesce(new.license, '')) ~ '^cc by([ -]sa)?[[:space:]]+[0-9](\.[0-9])?$'
  ) then
    new.commercial_use_allowed := true;
    new.api_redistribution_allowed := true;
    new.derivatives_allowed := true;
    new.attribution_required := lower(coalesce(new.license, '')) like 'cc by%';
    new.license_scope := 'open_license';
    new.rights_notes := case
      when lower(coalesce(new.license, '')) like 'cc by-sa%'
        then 'Redistribution/commercial use permitted under source license; adaptations remain subject to CC BY-SA attribution/share-alike requirements.'
      when lower(coalesce(new.license, '')) like 'cc by%'
        then 'Redistribution/commercial use permitted under source license with required attribution.'
      when lower(coalesce(new.license, '')) like 'cc0%'
        then 'CC0/public-domain dedication; preserve source/provenance even when attribution is not legally required.'
      when lower(coalesce(new.license, '')) like 'public domain%'
        then 'Public-domain source; preserve source/provenance and any source-specific notices.'
      else new.rights_notes
    end;
  elsif new.kind in ('licensed_editorial', 'official_press') and coalesce(new.license_scope, 'unknown') = 'unknown' then
    new.license_scope := 'contract_required';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ufc_apply_open_media_rights on public.ufc_images;
create trigger trg_ufc_apply_open_media_rights
before insert or update of kind, license on public.ufc_images
for each row execute function public.ufc_apply_open_media_rights();

-- Reclassify rows inserted after migration 007 but before this trigger.
update public.ufc_images
set license = license
where kind in ('wikimedia', 'public_domain');

comment on function public.ufc_apply_open_media_rights() is
  'Fail-closed media rights classifier: recognized open licenses gain commercial/API/derivative rights; editorial/provider rows remain closed without an explicit contract.';

commit;
