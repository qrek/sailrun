/**
 * Notifications : quand le joueur s'en va, on calcule ce qui va arriver à son bateau (sim/alerts.ts) et on
 * le prévient au bon moment.
 *  - Onglet resté ouvert (ordinateur) : le navigateur affiche lui-même les alertes à l'heure prévue.
 *  - Jeu fermé (téléphone surtout) : le calendrier part sur Supabase, et une fonction serveur envoie les
 *    notifications push à l'heure (docs/NOTIFICATIONS.md). Seulement si la clé VAPID publique est configurée.
 * Rien n'est demandé au joueur tant qu'il n'a pas appuyé sur « Activer les notifications ».
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Alert } from '../sim/alerts';
import { supabaseClient } from './supabaseFleet';

export type NotifyState = 'unsupported' | 'off' | 'on' | 'denied';

/** Clé publique VAPID des notifications push (la privée reste sur le serveur). Absente : alertes locales seulement. */
export const VAPID_PUBLIC_KEY: string | undefined = import.meta.env?.VITE_VAPID_PUBLIC_KEY || undefined;

const WANT_KEY = 'sailgame.notify.v1';

export function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
}

/** iPhone : les notifications web n'existent que pour le jeu installé sur l'écran d'accueil. */
export function needsInstall(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

export function notifyState(): NotifyState {
  if (!notifySupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  let want = false;
  try {
    want = localStorage.getItem(WANT_KEY) === '1';
  } catch {
    /* rien */
  }
  return Notification.permission === 'granted' && want ? 'on' : 'off';
}

function setWant(on: boolean) {
  try {
    localStorage.setItem(WANT_KEY, on ? '1' : '0');
  } catch {
    /* rien */
  }
}

let reg: Promise<ServiceWorkerRegistration | null> | null = null;
/** Le service worker (public/sw.js) : il affiche les notifications, même jeu fermé. */
export function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!notifySupported()) return Promise.resolve(null);
  return (reg ??= navigator.serviceWorker.register(`${import.meta.env?.BASE_URL ?? '/'}sw.js`).catch(() => null));
}

function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function pushSubscription(): Promise<PushSubscription | null> {
  if (!VAPID_PUBLIC_KEY) return null;
  const r = await registerWorker();
  if (!r || !('pushManager' in r)) return null;
  try {
    return (await r.pushManager.getSubscription()) ?? (await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) }));
  } catch {
    return null;
  }
}

/** À appeler sur un geste du joueur (le navigateur l'exige). */
export async function enableNotifications(): Promise<NotifyState> {
  if (!notifySupported()) return 'unsupported';
  const p = await Notification.requestPermission();
  if (p !== 'granted') {
    setWant(false);
    return p === 'denied' ? 'denied' : 'off';
  }
  setWant(true);
  await registerWorker();
  void pushSubscription();
  const r = await registerWorker();
  void r?.showNotification('Sail Run', { body: 'Notifications activées : on te prévient quand ton bateau a besoin de toi.', tag: 'sailrun-hello', icon: '/icons/icon-192.png' });
  return 'on';
}

export async function disableNotifications(raceId?: string) {
  setWant(false);
  local.disarm();
  if (raceId) await clearPushAlerts(raceId);
}

/* ---------- onglet ouvert : le navigateur affiche les alertes à l'heure ---------- */

class LocalAlerts {
  private timers: number[] = [];

  arm(alerts: Alert[]) {
    this.disarm();
    if (notifyState() !== 'on') return;
    const now = Date.now();
    for (const a of alerts) {
      const ms = a.at - now;
      if (ms < 0 || ms > 2 ** 31 - 1) continue;
      this.timers.push(
        window.setTimeout(async () => {
          if (!document.hidden) return; // le joueur est là : le jeu l'affiche déjà
          const r = await registerWorker();
          void r?.showNotification(a.title, { body: a.body, tag: `sailrun-${a.kind}`, icon: '/icons/icon-192.png' });
        }, ms),
      );
    }
  }

  disarm() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

export const local = new LocalAlerts();

/* ---------- jeu fermé : le calendrier part sur le serveur ---------- */

/** même client et même session anonyme que la flotte des joueurs */
const supabase = () => supabaseClient();

async function session(sb: SupabaseClient) {
  const s = (await sb.auth.getSession()).data.session;
  if (s) return s;
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

let lastSent = '';

/** Confie le calendrier au serveur (rien si les notifications push ne sont pas configurées ou pas activées). */
export async function syncPushAlerts(raceId: string, alerts: Alert[]): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY || notifyState() !== 'on') return false;
  const key = JSON.stringify([raceId, alerts.map((a) => [Math.round(a.at / 60000), a.kind])]);
  if (key === lastSent) return true;
  try {
    const sub = await pushSubscription();
    if (!sub) return false;
    const sb = await supabase();
    const me = await session(sb);
    const { error } = await sb.from('push_alerts').upsert(
      { player_id: me!.user.id, race_id: raceId, subscription: sub.toJSON(), alerts: alerts.map(({ at, kind, title, body }) => ({ at, kind, title, body })), sent_until: Date.now() },
      { onConflict: 'player_id,race_id' },
    );
    if (error) throw error;
    lastSent = key;
    return true;
  } catch {
    return false;
  }
}

async function clearPushAlerts(raceId: string) {
  if (!VAPID_PUBLIC_KEY) return;
  try {
    const sb = await supabase();
    await session(sb);
    await sb.from('push_alerts').delete().eq('race_id', raceId);
    lastSent = '';
  } catch {
    /* rien */
  }
}
