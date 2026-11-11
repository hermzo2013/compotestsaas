-- =====================================================================
-- RÉVISIO AI ENGINE — Schéma SQL complet
-- À exécuter dans Supabase > SQL Editor
-- Idempotent : peut être relancé sans erreur
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Configuration des fournisseurs d'IA
-- ---------------------------------------------------------------------
create table if not exists public.ai_providers (
  id uuid primary key default gen_random_uuid(),
  provider_name text not null unique check (provider_name in ('gemini', 'groq', 'openrouter', 'cloudflare')),
  api_key_encrypted text,
  api_key_iv text,
  api_key_tag text,
  account_id text,                       -- Cloudflare : identifiant de compte
  base_url text,                         -- URL de base (optionnelle)
  model text,                            -- Modèle par défaut pour ce fournisseur
  extra_config jsonb not null default '{}'::jsonb,
  enabled boolean not null default false,
  is_primary boolean not null default false,
  is_secondary boolean not null default false,
  status text not null default 'not_configured'
    check (status in ('not_configured', 'configured', 'connected', 'auth_error', 'quota_exceeded', 'disabled')),
  last_check_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ai_providers_primary_unique
  on public.ai_providers(is_primary) where is_primary = true;
create unique index if not exists ai_providers_secondary_unique
  on public.ai_providers(is_secondary) where is_secondary = true;

-- ---------------------------------------------------------------------
-- 2) Attribution des tâches aux fournisseurs
-- ---------------------------------------------------------------------
create table if not exists public.ai_task_routing (
  id uuid primary key default gen_random_uuid(),
  task_name text not null unique,
  primary_provider text check (primary_provider in ('gemini', 'groq', 'openrouter', 'cloudflare') or primary_provider is null),
  secondary_provider text check (secondary_provider in ('gemini', 'groq', 'openrouter', 'cloudflare') or secondary_provider is null),
  model_override text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3) Journalisation des appels IA
-- ---------------------------------------------------------------------
create table if not exists public.ai_logs (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  task_name text not null,
  provider_name text not null,
  model text,
  prompt_tokens int default 0,
  completion_tokens int default 0,
  total_tokens int default 0,
  duration_ms int,
  success boolean not null default false,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists ai_logs_created_idx on public.ai_logs(created_at desc);
create index if not exists ai_logs_provider_idx on public.ai_logs(provider_name, created_at desc);
create index if not exists ai_logs_user_idx on public.ai_logs(user_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4) Suivi des quotas
-- ---------------------------------------------------------------------
create table if not exists public.ai_quotas (
  id uuid primary key default gen_random_uuid(),
  provider_name text not null,
  period_type text not null check (period_type in ('hourly', 'daily', 'monthly')),
  period_start timestamptz not null,
  requests_count int not null default 0,
  tokens_count bigint not null default 0,
  limit_requests int,
  limit_tokens bigint,
  suspended_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_name, period_type, period_start)
);

create index if not exists ai_quotas_lookup_idx on public.ai_quotas(provider_name, period_type, period_start desc);

-- ---------------------------------------------------------------------
-- 5) Cache des réponses
-- ---------------------------------------------------------------------
create table if not exists public.ai_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  task_name text not null,
  provider_name text not null,
  model text,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  hit_count int not null default 0
);

create index if not exists ai_cache_expires_idx on public.ai_cache(expires_at);
create index if not exists ai_cache_task_idx on public.ai_cache(task_name, created_at desc);

-- ---------------------------------------------------------------------
-- 6) Réglages globaux du moteur IA
-- ---------------------------------------------------------------------
create table if not exists public.ai_settings (
  id int primary key default 1 check (id = 1),
  free_only_mode boolean not null default true,
  global_daily_limit int not null default 500,
  per_user_daily_limit int not null default 50,
  max_fallback_attempts int not null default 3,
  cache_ttl_seconds int not null default 3600,
  updated_at timestamptz not null default now()
);

insert into public.ai_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 7) Trigger updated_at
-- ---------------------------------------------------------------------
create or replace function public.ai_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists ai_providers_set_updated_at on public.ai_providers;
create trigger ai_providers_set_updated_at
  before update on public.ai_providers
  for each row execute function public.ai_set_updated_at();

drop trigger if exists ai_task_routing_set_updated_at on public.ai_task_routing;
create trigger ai_task_routing_set_updated_at
  before update on public.ai_task_routing
  for each row execute function public.ai_set_updated_at();

drop trigger if exists ai_quotas_set_updated_at on public.ai_quotas;
create trigger ai_quotas_set_updated_at
  before update on public.ai_quotas
  for each row execute function public.ai_set_updated_at();

drop trigger if exists ai_settings_set_updated_at on public.ai_settings;
create trigger ai_settings_set_updated_at
  before update on public.ai_settings
  for each row execute function public.ai_set_updated_at();

-- ---------------------------------------------------------------------
-- 8) RLS : verrouillage complet (accès uniquement via service_role)
-- ---------------------------------------------------------------------
alter table public.ai_providers enable row level security;
alter table public.ai_task_routing enable row level security;
alter table public.ai_logs enable row level security;
alter table public.ai_quotas enable row level security;
alter table public.ai_cache enable row level security;
alter table public.ai_settings enable row level security;
-- Aucune policy créée : accès service_role uniquement

-- ---------------------------------------------------------------------
-- 9) Nettoyage automatique du cache expiré
-- ---------------------------------------------------------------------
create or replace function public.ai_cache_cleanup() returns int
language plpgsql as $$
declare n int;
begin
  delete from public.ai_cache where expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Planification hebdomadaire (si pg_cron disponible)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ai-cache-cleanup-daily', '0 4 * * *', $cmd$select public.ai_cache_cleanup()$cmd$);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 10) Seed initial : fournisseurs (désactivés par défaut)
-- ---------------------------------------------------------------------
insert into public.ai_providers (provider_name, model, base_url) values
  ('gemini', 'gemini-2.0-flash', 'https://generativelanguage.googleapis.com/v1beta'),
  ('groq', 'llama-3.3-70b-versatile', 'https://api.groq.com/openai/v1'),
  ('openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'https://openrouter.ai/api/v1'),
  ('cloudflare', '@cf/meta/llama-3.1-8b-instruct', null)
on conflict (provider_name) do nothing;

-- ---------------------------------------------------------------------
-- 11) Seed initial : routage des tâches
-- ---------------------------------------------------------------------
insert into public.ai_task_routing (task_name, primary_provider, secondary_provider) values
  ('document_analysis', 'gemini', 'groq'),
  ('image_analysis', 'gemini', null),
  ('quiz_generation', 'groq', 'gemini'),
  ('pedagogical_assistant', 'groq', 'openrouter'),
  ('answer_explanation', 'gemini', 'groq'),
  ('course_summary', 'gemini', 'groq'),
  ('content_classification', 'cloudflare', 'groq'),
  ('student_analysis', 'groq', 'openrouter')
on conflict (task_name) do nothing;