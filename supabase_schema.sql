-- CompoTest SaaS v4 — à exécuter dans Supabase > SQL Editor.
-- Une ligne de données par utilisateur, protégée par Row Level Security.
create table if not exists public.comptest_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  quizzes jsonb not null default '[]'::jsonb,
  history jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint quizzes_is_array check (jsonb_typeof(quizzes) = 'array'),
  constraint history_is_array check (jsonb_typeof(history) = 'array')
);

alter table public.comptest_data enable row level security;
revoke all on public.comptest_data from anon;
grant select, insert, update, delete on public.comptest_data to authenticated;

drop policy if exists "Users can read their own CompoTest data" on public.comptest_data;
create policy "Users can read their own CompoTest data"
  on public.comptest_data for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own CompoTest data" on public.comptest_data;
create policy "Users can insert their own CompoTest data"
  on public.comptest_data for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own CompoTest data" on public.comptest_data;
create policy "Users can update their own CompoTest data"
  on public.comptest_data for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own CompoTest data" on public.comptest_data;
create policy "Users can delete their own CompoTest data"
  on public.comptest_data for delete to authenticated
  using (auth.uid() = user_id);
