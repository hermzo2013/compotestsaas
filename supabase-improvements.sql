-- =====================================================================
-- Révisio — améliorations (langue, matières/niveau, suivi des clics, nettoyage automatique)
-- À exécuter dans Supabase : SQL Editor > New query > coller > Run
-- Prérequis : supabase-push-fcm.sql déjà exécuté. Script idempotent (relançable sans danger).
-- Tant qu'il n'est pas exécuté, l'application continue de fonctionner (fonctions avancées désactivées).
-- =====================================================================

-- 1) Personnalisation et langue des abonnés
alter table public.push_subscriptions add column if not exists language text not null default 'fr';
alter table public.push_subscriptions add column if not exists preferred_subjects text[] not null default '{}';
alter table public.push_subscriptions add column if not exists preferred_level text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'push_subscriptions_language_chk') then
    alter table public.push_subscriptions add constraint push_subscriptions_language_chk check (language in ('fr', 'en'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'push_subscriptions_level_chk') then
    alter table public.push_subscriptions add constraint push_subscriptions_level_chk
      check (preferred_level is null or preferred_level in ('LICENCE 1', 'LICENCE 2', 'LICENCE 3'));
  end if;
end $$;

-- 2) Suivi des ouvertures et traductions des messages
alter table public.push_messages add column if not exists click_count int not null default 0;
alter table public.push_messages add column if not exists translations jsonb;

-- Incrément atomique du compteur de clics (appelé uniquement par le serveur : clé service_role)
create or replace function public.increment_push_click(p_id uuid) returns void
language sql as $$
  update public.push_messages set click_count = click_count + 1 where id = p_id;
$$;
revoke all on function public.increment_push_click(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.increment_push_click(uuid) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.increment_push_click(uuid) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.increment_push_click(uuid) to service_role; end if;
end $$;

-- 3) Nettoyage automatique : supprime les appareils non mis à jour depuis plus de N mois (6 par défaut).
--    updated_at est rafraîchi à chaque connexion de l'appareil (réenregistrement automatique, au plus toutes les 12 h).
create index if not exists push_subscriptions_updated_idx on public.push_subscriptions(updated_at);

create or replace function public.push_cleanup_stale(p_months int default 6) returns int
language plpgsql as $$
declare n int;
begin
  if p_months < 1 then raise exception 'p_months doit être >= 1'; end if;
  delete from public.push_subscriptions where updated_at < now() - make_interval(months => p_months);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.push_cleanup_stale(int) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.push_cleanup_stale(int) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.push_cleanup_stale(int) from authenticated; end if;
end $$;

-- 4) Planification (pg_cron) : chaque dimanche à 03:00 UTC.
--    Si l'extension n'est pas disponible, activez-la dans Database > Extensions (pg_cron) puis relancez ce script.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron indisponible (%). Activez-le dans Database > Extensions puis relancez le script.', sqlerrm;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('push-cleanup-weekly', '0 3 * * 0', $cmd$select public.push_cleanup_stale(6)$cmd$);
    raise notice 'Nettoyage hebdomadaire planifié (push-cleanup-weekly).';
  end if;
end $$;

-- Utile : lancer le nettoyage à la main      select public.push_cleanup_stale(6);
-- Utile : voir / arrêter la planification    select * from cron.job;   select cron.unschedule('push-cleanup-weekly');
