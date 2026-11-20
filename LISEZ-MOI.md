# Révisio — Refonte UX mobile

## Installation
Copier dans le dossier du projet (même niveau que `index.html`) :
`mobile-ux.css`, `mobile-ux.js`, `pagination.js`, et remplacer `index.html`, `server.js`, `sw.js`.
`index.html.diff` montre exactement ce qui a changé dans `index.html` (≈ +1,4 Ko seulement).

## ⚠️ Fonctions existantes modifiées (règle 5) — 3 ajouts d'UNE ligne, rien n'est supprimé
L'ancien code reste en dessous de chaque ligne : il sert de **repli** si `pagination.js` ne se charge pas.

**renderCourses()** — ajouté juste avant `const levels = [...]` :
```js
if (window.RevisioPager) return window.RevisioPager.renderCourses(list, filtered);
```
**renderLibraryList()** — ajouté juste avant `list.innerHTML = filtered.map(q => {` :
```js
if (window.RevisioPager) { window.RevisioPager.renderLibrary(list, filtered, moreHtml); updateLibraryActionBar(); return; }
```
**renderHistory()** — ajouté juste avant `list.innerHTML = [...historyData].reverse()` :
```js
if (window.RevisioPager) { window.RevisioPager.renderHistory(list); return; }
```

## Autres modifications d'index.html
| Zone | Avant | Après |
|---|---|---|
| `<head>` | — | `<link rel="stylesheet" href="/mobile-ux.css">` |
| `<header>` | 8 gros boutons + libellé | Logo · cloche `#bellBtn` · avatar `#profileBtn` + menu `#profileMenu` (tous les anciens boutons y sont déplacés **avec leurs IDs**) |
| Onglets du bas | `🌍 Bibliothèque` (emoji + texte) | `<i class="tab-ico"></i><span class="tab-lbl">…</span>` (icône par CSS) |
| Fin de page | — | `<script src="/pagination.js" defer>` et `/mobile-ux.js` |

## Fichiers ajoutés / autres fichiers touchés
| Fichier | Rôle |
|---|---|
| `mobile-ux.css` | Barre flottante (verre, 30px, ombre, mode sombre), header, cartes, pagination, modale, chat +100px, profil |
| `mobile-ux.js` | Menu Profil, avatar, bouton « + » admin + feuille d'actions, page Profil > À propos, modale « Ajouter un cours » |
| `pagination.js` | Pagination (cours 10 / quiz 15 / admin 10-20-50), cartes, filtres cours, URL, Historique (pastille + Refaire) |
| `server.js` | 3 noms ajoutés à la liste blanche `PUBLIC_FILES` (sinon 404) |
| `sw.js` | `APP_VERSION` `revisio-v4` → `revisio-v5` (purge du cache) |

## Récapitulatif par demande
| # | Demande | Statut |
|---|---|---|
| 1 | Header : logo / cloche / avatar, menu déroulant (Notifications, Déconnexion…) | ✅ |
| 1 | Une seule bannière Android, ✕, mémorisée (`revisio_apk_banner_dismissed`) | ✅ (logique existante de `download-android.js`; bouton du header déplacé dans le menu) |
| 1 | Footer légal → Profil > À propos | ✅ (footer masqué par CSS, non supprimé) |
| 2 | Barre flottante, 4 onglets, bulle sur l'onglet actif, mode sombre | ✅ |
| 2 | Bouton central « + » admin (Créer un test / Importer HTML) | ✅ |
| 3 | Cours lambda : recherche, filtres Niveau + PDF/Vidéo, carte 1 bouton, titre propre, code en petit | ✅ |
| 4 | Cours admin : formulaire caché, modale via « ＋ Ajouter », 1 champ/ligne | ✅ |
| 5 | Bibliothèque : carte 2 lignes + [▶️ Lancer], sans Modifier/Supprimer en lambda | ✅ |
| 6 | Historique : pastille rouge <10 / orange 10-14 / verte >14 + « Refaire » | ✅ |
| 7 | Chat à 100px | ✅ |
| 8 | Pagination complète (précédent/suivant, « Affichage : 1 - 10 sur 33 », scroll haut, retour page 1, URL, sélecteur admin) | ✅ |
| 9 | Style général (#1A1A1A / #6B7280, cartes arrondies, 360px) | ✅ |

## Points à connaître (décisions prises)
1. **« INFAS Agboville »** : la table `courses` n'a pas de colonne établissement. Valeur par défaut dans `pagination.js` (`window.REVISIO_INSTITUTION`), à changer si besoin.
2. **URL** : l'app est une page unique, donc `?tab=courses&page=2&niveau=L1` (et non `/cours?...`). Un vrai chemin `/cours` demanderait une route dans `server.js`.
3. **Quiz** : l'API charge 20 quiz à la fois ; pour afficher « Page x sur y », `pagination.js` charge le reste du catalogue une fois (via `loadMoreLibrary(true)` existant).
4. **Cours en admin** : la sélection multiple reste disponible (barre « Déplacer / Supprimer ») ; si la sélection touche plusieurs niveaux, une confirmation s'affiche par niveau (fonctions existantes inchangées).
5. **Cours avec PDF + vidéo** : bouton principal « Télécharger » + petite icône ▶ pour la vidéo.
6. **Refaire** : l'historique ne stocke que le titre ; on retrouve le quiz par son titre dans la bibliothèque, sinon on ouvre la bibliothèque avec la recherche pré-remplie.
7. **Admin** : à la connexion il arrive sur « Créer un test » (`DEFAULT_TAB_ADMIN`), donc aucun onglet du bas n'est surligné. Si tu préfères la Bibliothèque : `const DEFAULT_TAB_ADMIN = 'library';` (non modifié).
8. **`www/index.html`** (copie Capacitor, ancienne version) n'a pas été touché.
9. `bottom:20px` ajoute aussi `env(safe-area-inset-bottom)` (iPhone avec barre d'accueil).

## Vérifications effectuées
- `startExam`, `renderExamQuestion`, l'authentification Supabase, le parser HTML et la logique admin : **aucune ligne modifiée** (voir `index.html.diff`).
- Tous les IDs existants sont conservés (`bellBtn`, `pushBtn`, `pwdBtn`, `logoutBtn`, `adminBtn`, `apkBtn`, `userLabel`, `darkModeBtn`, `globalSearchBtn`, `adminCourseForm`…).
- Syntaxe JS valide (index.html + nouveaux fichiers). Test jsdom : pagination, filtres, retour page 1, URL, titres nettoyés, pastilles, sélecteur admin → OK.
- **Non testé ici** : rendu visuel sur téléphone et connexion Supabase réelle (pas de navigateur ni de réseau dans mon environnement), et la suite `vitest` du projet (dépendances Windows). À lancer chez toi : `npm test`, puis un contrôle à 360 px.

---
## Mise à jour (2e mission) — seuls `mobile-ux.css` et `pagination.js` changent
`index.html`, `server.js`, `sw.js`, `mobile-ux.js` : inchangés. Aucune nouvelle fonction existante modifiée (les 3 lignes de délégation restent les seules).

| Zone | Modification |
|---|---|
| Header | Hauteur 56px, padding 8px, logo 24px, avatar et cloche 38px, `position: sticky` |
| Cours | Icône après le titre, même ligne : 📄 (PDF), ▶️ (vidéo), les deux si les deux existent. Titre sur 2 lignes max, `word-break: normal`, ellipsis, sans majuscules forcées, code interne en petit dessous |
| Cours | Pagination : boutons « Précédent / Page x sur y / Suivant » puis « Affichage : 1 - 10 sur 33 cours » |
| Bibliothèque | **5 quiz par page** (constante `DEFAULTS.library` dans `pagination.js`), même ordre d'affichage |
| Bibliothèque admin | Déplacer / Modifier / Supprimer dans un menu discret « ⋯ » ; rien en mode lambda |
| Sélecteur admin 10/20/50 | Désactivé (non repris dans cette mission) ; `ADMIN_PERPAGE_SELECTOR = true` le réactive |
| Navigation | Onglets d'au moins 48px |
| Chat | Remonté de 90px (au lieu de 100) |
| Bas de page | `padding-bottom: 110px` sous les listes et les autres onglets |
| Cartes | Attribut `data-id` sur chaque carte (cours, quiz, historique) |

Vérifié par test jsdom : 5 quiz par page, « Page 1 sur 8 » pour 40 quiz, bouton « Suivant » désactivé en dernière page, retour page 1 au changement de filtre, menu « ⋯ » présent en admin et absent en lambda, icône après le titre.
Non testé ici : rendu visuel sur téléphone et connexion Supabase.
