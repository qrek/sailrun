/**
 * La flotte des joueurs sur Supabase : table `positions` (supabase/migrations), une session anonyme par
 * navigateur (pas de compte), et des règles d'accès qui ne laissent chacun écrire que sa propre ligne.
 * Le client n'est chargé qu'au premier échange, donc jamais hors de la Route du Rhum.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FleetApi, FleetRow } from './fleet';

/** Projet Supabase du jeu : adresse et clé publiable (faite pour être publique, protégée par les règles d'accès). */
export const SUPABASE_URL: string = import.meta.env?.VITE_SUPABASE_URL || 'https://njuxerstcizipzxpvemq.supabase.co';
export const SUPABASE_KEY: string = import.meta.env?.VITE_SUPABASE_KEY || 'sb_publishable_gdTGcoYthTNKcfcszXNFIw_hkYDKdQU';

export function supabaseFleet(url = SUPABASE_URL, key = SUPABASE_KEY): FleetApi {
  let client: Promise<SupabaseClient> | null = null;
  const get = () =>
    (client ??= import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sailgame.fleet.auth' } }),
    ));
  return {
    async publish(row: FleetRow) {
      const sb = await get();
      let session = (await sb.auth.getSession()).data.session;
      if (!session) {
        // pas de compte : une identité anonyme, gardée dans ce navigateur
        const { data, error } = await sb.auth.signInAnonymously();
        if (error) throw error;
        session = data.session;
      }
      const id = session!.user.id;
      const { error } = await sb.from('positions').upsert({ ...row, player_id: id }, { onConflict: 'player_id,race_id' });
      if (error) throw error;
      return id;
    },
    async list(raceId: string) {
      const sb = await get();
      const { data, error } = await sb.from('positions').select('*').eq('race_id', raceId).order('updated_at', { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as FleetRow[];
    },
  };
}
