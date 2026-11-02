/**
 * Envoie les notifications push dont l'heure est venue (table public.push_alerts).
 * Appelée toutes les 5 minutes par pg_cron. Secrets : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 * (mailto:…), CRON_SECRET. Voir docs/NOTIFICATIONS.md.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

interface Alert {
  at: number;
  kind: string;
  title: string;
  body: string;
}

/** une alerte en retard de plus de 30 min n'est plus envoyée (serveur en panne, etc.) */
const STALE_MS = 30 * 60000;

Deno.serve(async (req) => {
  if (req.headers.get('authorization') !== `Bearer ${Deno.env.get('CRON_SECRET')}`) return new Response('interdit', { status: 401 });
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now();
  // calendriers mis à jour ces 10 derniers jours (une course au large)
  const { data, error } = await sb
    .from('push_alerts')
    .select('player_id, race_id, subscription, alerts, sent_until')
    .gte('updated_at', new Date(now - 10 * 86400000).toISOString())
    .limit(5000);
  if (error) return new Response(error.message, { status: 500 });
  let sent = 0;
  let gone = 0;
  for (const row of data ?? []) {
    const due = (row.alerts as Alert[]).filter((a) => a.at > row.sent_until && a.at <= now);
    if (!due.length) continue;
    const fresh = due.filter((a) => now - a.at < STALE_MS);
    // plusieurs alertes à la fois : une seule notification, la plus récente, avec le compte
    const last = fresh[fresh.length - 1];
    let dead = false;
    if (last) {
      const body = fresh.length > 1 ? `${last.body} (+${fresh.length - 1} autre${fresh.length > 2 ? 's' : ''})` : last.body;
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({ title: last.title, body, tag: `sailrun-${last.kind}`, url: '/' }), { TTL: 3600 });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        dead = code === 404 || code === 410; // abonnement expiré : on le retire
      }
    }
    const q = sb.from('push_alerts');
    if (dead) {
      gone++;
      await q.delete().eq('player_id', row.player_id).eq('race_id', row.race_id);
    } else {
      await q.update({ sent_until: now }).eq('player_id', row.player_id).eq('race_id', row.race_id);
    }
  }
  return Response.json({ sent, gone });
});
