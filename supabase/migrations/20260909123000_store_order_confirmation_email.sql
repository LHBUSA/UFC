-- Branded order-confirmation delivery state.
alter table public.store_orders
  add column if not exists confirmation_email_sent_at timestamptz,
  add column if not exists confirmation_email_provider_id text;

comment on column public.store_orders.confirmation_email_sent_at is
  'When the branded PropBetEdge order confirmation email was accepted by the email provider.';
comment on column public.store_orders.confirmation_email_provider_id is
  'Provider message id returned for the branded order confirmation email.';
