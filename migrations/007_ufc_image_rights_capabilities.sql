-- PropBetEdge UFC — 007: machine-readable media rights capabilities
--
-- The media catalog is a product surface, not just website decoration. These
-- flags distinguish display/storage rights from commercial redistribution.
-- Provider/editorial assets remain closed by default until the governing
-- contract explicitly grants the capability.

begin;

alter table public.ufc_images
  add column if not exists commercial_use_allowed boolean not null default false,
  add column if not exists api_redistribution_allowed boolean not null default false,
  add column if not exists derivatives_allowed boolean not null default false,
  add column if not exists attribution_required boolean not null default true,
  add column if not exists license_scope text not null default 'unknown',
  add column if not exists rights_notes text;

-- Existing Wikimedia/public-domain rows were already admitted only through
-- the strict free-license allowlist in fetch_fighter_portraits.mjs. Mark the
-- capabilities that follow from those licenses. Attribution/license notices
-- still travel with every API response.
update public.ufc_images
set
  commercial_use_allowed = true,
  api_redistribution_allowed = true,
  derivatives_allowed = true,
  attribution_required = case
    when lower(coalesce(license, '')) like 'cc by%' then true
    else false
  end,
  license_scope = 'open_license',
  rights_notes = case
    when lower(coalesce(license, '')) like 'cc by-sa%'
      then 'Redistribution/commercial use permitted under source license; adaptations remain subject to CC BY-SA attribution/share-alike requirements.'
    when lower(coalesce(license, '')) like 'cc by%'
      then 'Redistribution/commercial use permitted under source license with required attribution.'
    when lower(coalesce(license, '')) like 'cc0%'
      then 'CC0/public-domain dedication; preserve source/provenance even when attribution is not legally required.'
    when lower(coalesce(license, '')) like 'public domain%'
      then 'Public-domain source; preserve source/provenance and any source-specific notices.'
    else rights_notes
  end
where kind in ('wikimedia', 'public_domain')
  and (
    lower(coalesce(license, '')) ~ '^cc0([[:space:]]*1\.0)?$'
    or lower(coalesce(license, '')) ~ '^public domain'
    or lower(coalesce(license, '')) ~ '^cc by([ -]sa)?[[:space:]]+[0-9](\.[0-9])?$'
  );

-- Commercial/editorial/press rows deliberately remain false unless a future
-- source-specific migration or ingest adapter has an explicit contract basis.
update public.ufc_images
set
  license_scope = case
    when kind in ('licensed_editorial', 'official_press') then 'contract_required'
    else license_scope
  end
where kind in ('licensed_editorial', 'official_press')
  and license_scope = 'unknown';

create index if not exists ufc_images_api_redistributable_idx
  on public.ufc_images (fighter_id, api_redistribution_allowed, created_at desc)
  where fighter_id is not null;

comment on column public.ufc_images.api_redistribution_allowed is
  'True only when PropBetEdge has an explicit license/public-domain basis to deliver the image bytes/URL through a customer-facing API.';
comment on column public.ufc_images.commercial_use_allowed is
  'True only when the underlying rights basis permits commercial use.';
comment on column public.ufc_images.derivatives_allowed is
  'True when the rights basis permits resizing/cropping/other derivative renditions; source-license conditions still apply.';
comment on column public.ufc_images.license_scope is
  'open_license, contract_required, contracted, or unknown. Contracted assets must be set by a source-specific adapter/migration.';

commit;
