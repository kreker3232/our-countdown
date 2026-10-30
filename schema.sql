-- Run once in Supabase Dashboard → SQL Editor → New query.
-- Public players can read names and high scores. Only signed-in players can
-- submit scores, and the database only ever raises the stored personal best.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 20),
  best_score integer not null default 0 check (best_score >= 0 and best_score <= 1000000),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Anyone can read leaderboard" on public.profiles;
create policy "Anyone can read leaderboard"
  on public.profiles for select
  to anon, authenticated
  using (true);

grant select on table public.profiles to anon, authenticated;
revoke insert, update, delete on table public.profiles from anon, authenticated;

create or replace function public.create_player_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  chosen_name text;
begin
  chosen_name := trim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  if chosen_name = '' then chosen_name := 'Игрок'; end if;
  insert into public.profiles (id, display_name)
  values (new.id, left(chosen_name, 20));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.create_player_profile();

create or replace function public.submit_score(score_in integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_best integer;
begin
  if auth.uid() is null then
    raise exception 'Войди в аккаунт, чтобы сохранить рекорд.' using errcode = '28000';
  end if;
  if score_in is null or score_in < 0 or score_in > 1000000 then
    raise exception 'Недопустимый результат.' using errcode = '22023';
  end if;

  insert into public.profiles (id, display_name, best_score)
  values (
    auth.uid(),
    coalesce((select left(display_name, 20) from public.profiles where id = auth.uid()), 'Игрок'),
    score_in
  )
  on conflict (id) do update
    set best_score = greatest(public.profiles.best_score, excluded.best_score)
  returning best_score into new_best;

  return new_best;
end;
$$;

revoke all on function public.submit_score(integer) from public;
grant execute on function public.submit_score(integer) to authenticated;

