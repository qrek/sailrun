-- Notifications push : le calendrier d'alertes de chaque joueur (checkpoint atteint, route terminée, côte,
-- skipper épuisé, arrivée…), calculé par le jeu au moment où le joueur s'en va. La fonction push-alerts
-- (supabase/functions/push-alerts) envoie celles dont l'heure est venue. Voir docs/NOTIFICATIONS.md.

create table if not exists public.push_alerts (
  player_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  race_id text not null check (char_length(race_id) between 1 and 40),
  -- abonnement push du navigateur (PushSubscription.toJSON())
  subscription jsonb not null check (jsonb_typeof(subscription) = 'object' and char_length(subscription ->> 'endpoint') between 10 and 1000),
  -- [{ at: ms UTC, kind, title, body }], 12 au plus
  alerts jsonb not null default '[]' check (jsonb_typeof(alerts) = 'array' and jsonb_array_length(alerts) <= 12),
  -- alertes déjà envoyées : toutes celles dont at <= sent_until (ms UTC)
  sent_until bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (player_id, race_id)
);

create index if not exists push_alerts_updated on public.push_alerts (updated_at desc);

create or replace function public.push_alerts_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists push_alerts_touch on public.push_alerts;
create trigger push_alerts_touch before insert or update on public.push_alerts
for each row execute function public.push_alerts_touch();

alter table public.push_alerts enable row level security;

-- chacun ne voit et ne touche que son propre calendrier (la fonction d'envoi passe par la clé service)
drop policy if exists "mes alertes : lecture" on public.push_alerts;
create policy "mes alertes : lecture" on public.push_alerts
for select to authenticated using (player_id = (select auth.uid()));

drop policy if exists "mes alertes : ajout" on public.push_alerts;
create policy "mes alertes : ajout" on public.push_alerts
for insert to authenticated with check (player_id = (select auth.uid()));

drop policy if exists "mes alertes : mise à jour" on public.push_alerts;
create policy "mes alertes : mise à jour" on public.push_alerts
for update to authenticated using (player_id = (select auth.uid())) with check (player_id = (select auth.uid()));

drop policy if exists "mes alertes : retrait" on public.push_alerts;
create policy "mes alertes : retrait" on public.push_alerts
for delete to authenticated using (player_id = (select auth.uid()));

-- Envoi toutes les 5 minutes : à activer une fois la fonction déployée (docs/NOTIFICATIONS.md, étape 4),
-- les extensions pg_cron et pg_net doivent être actives.
-- select cron.schedule('push-alerts', '*/5 * * * *', $$
--   select net.http_post(
--     url := 'https://<projet>.supabase.co/functions/v1/push-alerts',
--     headers := jsonb_build_object('Authorization', 'Bearer ' || '<CRON_SECRET>')
--   );
-- $$);
