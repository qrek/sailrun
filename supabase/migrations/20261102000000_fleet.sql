-- Flotte des joueurs : la dernière position connue de chaque joueur, course par course.
-- Le jeu reste maître de chaque bateau (simulé et sauvegardé dans le navigateur) : cette table ne fait que
-- relayer les positions pour que les joueurs se voient. Pas de compte : chaque navigateur ouvre une session
-- anonyme Supabase (à activer : Authentication > Sign In / Providers > Allow anonymous sign-ins).

create table if not exists public.positions (
  player_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  race_id text not null check (char_length(race_id) between 1 and 40),
  name text not null check (char_length(name) between 1 and 24),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  hull text not null default 'classique' check (char_length(hull) <= 20),
  foils text not null default 'c' check (char_length(foils) <= 20),
  mast text not null default 'aile' check (char_length(mast) <= 20),
  lon double precision not null check (lon between -180 and 180),
  lat double precision not null check (lat between -90 and 90),
  hdg real not null check (hdg >= 0 and hdg < 360),
  spd real not null check (spd between 0 and 60),
  sail text not null check (sail in ('foc', 'code0', 'spi')),
  mark smallint not null default 0 check (mark between 0 and 50),
  -- heures de course à l'arrivée (null : encore en mer), et heures de course au moment de la position
  finished real check (finished is null or finished >= 0),
  race_t real not null check (race_t >= 0),
  updated_at timestamptz not null default now(),
  primary key (player_id, race_id)
);

create index if not exists positions_race_recent on public.positions (race_id, updated_at desc);

-- l'heure de mise à jour vient de la base, pas du navigateur
create or replace function public.positions_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists positions_touch on public.positions;
create trigger positions_touch before insert or update on public.positions
for each row execute function public.positions_touch();

alter table public.positions enable row level security;

-- tout le monde voit la flotte
drop policy if exists "flotte visible" on public.positions;
create policy "flotte visible" on public.positions
for select to anon, authenticated using (true);

-- chacun ne publie et ne modifie que son propre bateau
drop policy if exists "mon bateau : ajout" on public.positions;
create policy "mon bateau : ajout" on public.positions
for insert to authenticated with check (player_id = (select auth.uid()));

drop policy if exists "mon bateau : mise à jour" on public.positions;
create policy "mon bateau : mise à jour" on public.positions
for update to authenticated using (player_id = (select auth.uid())) with check (player_id = (select auth.uid()));

drop policy if exists "mon bateau : retrait" on public.positions;
create policy "mon bateau : retrait" on public.positions
for delete to authenticated using (player_id = (select auth.uid()));
