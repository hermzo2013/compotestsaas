# Révisio — lot d'améliorations (23 points)

## Installation
1. **Supabase** : SQL Editor → lancer `supabase-improvements.sql` (après `supabase-push-fcm.sql` déjà exécuté). Script relançable. Tant qu'il n'est pas lancé, l'application fonctionne comme avant (langue, matières, clics et nettoyage inactifs). `pg_cron` : si le script le signale, activez-le dans Database → Extensions puis relancez.
2. **Dépendances** : `npm install` (nouvelles : `zod`, `pino` ; de développement : `vitest`, `supertest`, `jsdom`).
3. **GitHub** : remplacez/ajoutez tous les fichiers de ce zip (dossier `tests/` compris), puis `git push`.
4. **Render** (facultatif) : variables `LOG_LEVEL`, `API_RATE_PER_MIN`, `AI_RATE_PER_MIN`, `AI_RATE_PER_HOUR`, `PUSH_SUBSCRIBE_LIMIT` (voir `.env.example`).
5. **Tests** : `npm test` (79 tests, sans réseau).

## Où est chaque point
| # | Point | Fichiers |
|---|---|---|
| 1 | Vider les notifications à l'ouverture ; tag `new-quiz` vérifié (web et Android) | push-client.js, push.js |
| 2 | Invitation après 1er quiz ou 3 visites, fermable, pause 7 jours | push-client.js, index.html |
| 3 | Mode sombre des fenêtres de notification | push-client.js |
| 4 | Nettoyage automatique des abonnements inactifs depuis 6 mois | supabase-improvements.sql |
| 5 | Préférences en cache (localStorage) | push-client.js |
| 6 | Limiteur 5 requêtes/min/IP sur /api/push/subscribe | server.js |
| 7 | « Mes notifications » (10 dernières, pastille de non-lus) | push-client.js, push.js, index.html |
| 8 | Alertes par matière / niveau | push-client.js, push.js, schemas.js, SQL |
| 9 | Langue FR/EN des notifications | i18n.js, push.js, push-client.js, SQL |
| 10 | Suivi des ouvertures (?from=push, /api/push/click, click_count) | push.js, push-client.js, SQL |
| 11 | Validation Zod (quiz, comptes, IA, notifications) | schemas.js, server.js, push.js |
| 12 | Gestion globale des erreurs | server.js |
| 13 | Limiteurs ciblés (comptes, IA) | server.js |
| 14 | Cache des quiz (navigateur 5 min + serveur 5 min) | server.js, index.html |
| 15 | Pagination ?page=&limit= | server.js, index.html |
| 16 | Squelettes de chargement | ui-extras.js, index.html |
| 17 | Quiz consultables hors ligne | sw.js, offline.html |
| 18 | Bandeau « Vous êtes hors ligne » | ui-extras.js |
| 19 | Accueil admin (statistiques) | server.js, admin-extras.js, index.html |
| 20 | Recherche et filtre « bannis » des comptes | admin-extras.js, index.html |
| 21 | Suppression de l'historique des notifications | push.js, push-client.js, index.html |
| 22 | Tests vitest | tests/*.test.js, vitest.config.js |
| 23 | Logs JSON (pino) | logger.js, server.js, push.js |

## Points d'attention
- **IP réelle derrière Render** : `trust proxy` est activé. Avant, tous les visiteurs partageaient peut-être la même « IP » pour les limiteurs. Si tout un campus partage une IP publique, augmentez `PUSH_SUBSCRIBE_LIMIT`.
- **Cache des quiz** : le serveur vide son cache à chaque création/modification/suppression ; le navigateur d'un autre utilisateur peut garder la liste jusqu'à 5 minutes.
- **Bibliothèque** : 20 quiz par page ; une recherche ou un filtre charge automatiquement les pages restantes. La liste des comptes admin passe de 100 à 1000 comptes.
- **Erreurs** : une promesse rejetée est journalisée ; une exception non interceptée est journalisée puis le processus s'arrête pour que Render le relance proprement.
- **Hors ligne** : la liste des quiz et les bonnes réponses sont consultables dans `offline.html`. L'application complète hors ligne dépend de la session enregistrée sur l'appareil.
- Les messages écrits par l'admin ne sont pas traduits automatiquement : un champ « anglais » facultatif est prévu.
