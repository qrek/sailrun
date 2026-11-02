# Notifications

Quand le joueur quitte le jeu, on calcule ce qui va arriver à son bateau si personne ne touche à la barre (`src/sim/alerts.ts`) : checkpoint atteint, route terminée, marque passée, bateau bloqué contre la côte, skipper épuisé, meilleure voile qui change (voiles à la main), arrivée. Horizon : 48 h, 12 alertes au plus.

Deux façons de les livrer :

| Situation | Qui affiche l'alerte | Ce qu'il faut |
| --- | --- | --- |
| Onglet resté ouvert (ordinateur) | le navigateur, à l'heure prévue | rien : marche dès que le joueur active les notifications |
| Jeu fermé (téléphone surtout) | le serveur, en notification push | la mise en place ci-dessous |

Le joueur active les notifications dans **Options** ou depuis la carte « Pendant ton absence ». Sur iPhone, il faut d'abord installer le jeu sur l'écran d'accueil (Partager → Sur l'écran d'accueil) : c'est la règle d'Apple pour les notifications web.

## Mise en place du push (une fois)

1. **Clés VAPID** (elles signent les notifications) :
   ```
   npx web-push generate-vapid-keys
   ```
2. **Vercel** → Settings → Environment Variables : `VITE_VAPID_PUBLIC_KEY` = la clé publique (Production et Preview), puis redéployer. Sans cette variable, le jeu reste en alertes locales seulement.
3. **Base** : appliquer `supabase/migrations/20261102120000_push_alerts.sql` (`supabase db push`, ou coller le fichier dans le SQL Editor).
4. **Fonction d'envoi** :
   ```
   supabase secrets set VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:toi@exemple.fr CRON_SECRET=<une longue chaîne au hasard>
   supabase functions deploy push-alerts --no-verify-jwt
   ```
5. **Toutes les 5 minutes** : activer les extensions `pg_cron` et `pg_net` (Database → Extensions), puis dans le SQL Editor :
   ```sql
   select cron.schedule('push-alerts', '*/5 * * * *', $$
     select net.http_post(
       url := 'https://<projet>.supabase.co/functions/v1/push-alerts',
       headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
     );
   $$);
   ```
6. **Essai** : activer les notifications dans le jeu, poser un checkpoint à 10 milles, fermer l'onglet. La notification arrive à l'heure prévue, à 5 minutes près.

## Comment ça circule

- Le joueur cache le jeu → `game.armAlerts()` calcule le calendrier, arme les minuteries locales et l'envoie dans `push_alerts` (une ligne par joueur et par course, même session anonyme que la flotte).
- Toutes les 5 min, `push-alerts` envoie les alertes échues depuis le dernier passage (une seule notification si plusieurs tombent ensemble), ignore celles en retard de plus de 30 min et supprime les abonnements expirés.
- Le service worker (`public/sw.js`) n'affiche rien si le jeu est déjà ouvert à l'écran.
- Limite connue : les concurrents ne sont pas simulés côté serveur, donc pas d'alerte « untel te double ». Une avarie ne se prévoit pas non plus.
