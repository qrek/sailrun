/* Sail Run : service worker des notifications (pas de cache hors ligne, le jeu reste servi par Vercel). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const visibleClient = async () => {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return list.find((c) => c.visibilityState === 'visible') || null;
};

// notification push envoyée par le serveur (supabase/functions/push-alerts)
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: 'Sail Run', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    (async () => {
      // le joueur est déjà dans le jeu : il voit l'alerte à l'écran
      if (await visibleClient()) return;
      await self.registration.showNotification(d.title || 'Sail Run', {
        body: d.body || '',
        tag: d.tag || 'sailrun',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: d.url || '/' },
      });
    })(),
  );
});

// un tap sur la notification : on revient dans le jeu
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = list.find((c) => 'focus' in c);
      if (open) return open.focus();
      return self.clients.openWindow((e.notification.data && e.notification.data.url) || '/');
    })(),
  );
});
