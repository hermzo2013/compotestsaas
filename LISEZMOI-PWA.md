# Révisio — version mobile (PWA) : ce qui a été fait et comment la mettre en ligne

## Contenu de cette archive (copiez-les à la racine de votre projet, en remplaçant)
| Fichier | État |
|---|---|
| `icons/` (4 PNG) | **Nouveau** : icônes générées (192, 512, maskable 512, iOS 180) |
| `sw.js` | **Corrigé** (v2) : voir « Problèmes corrigés » |
| `manifest.json` | Ajout de `"id": "/"` (identité stable de l'app) |
| `index.html` | **+60 lignes** : balises PWA dans `<head>` + un bloc `<script>` avant `</body>` (service worker, bannière « Installer », raccourcis) |
| `server.js` | **+27 lignes** : routes `/sw.js` et `/manifest.json`, correction du cache, blocage de `server.js`/`package.json`/`node_modules` |
| `favicon.png`, `site.png` | **Allégés** : 1,4 Mo → 20 Ko et 1,1 Mo → 70 Ko (mêmes visuels) |
| `offline.html` | Inchangé |
| `generate-icons.js`, `optimize-images.js` | Scripts pour regénérer icônes / images (facultatif) |

Vos fichiers originaux sont à conserver au cas où : seuls `index.html`, `server.js`, `sw.js` et `manifest.json` ont été modifiés.
Fins de ligne (CRLF) conservées dans `index.html` et `server.js`.

## Problèmes trouvés et corrigés
1. **Icônes absentes** : `manifest.json` et `sw.js` pointaient vers `/icons/*.png` qui n'existaient pas → app non installable. Créées. Votre script cherchait `logo-source.png` alors que le fichier envoyé s'appelle `logo-source_png.png` (renommez-le si vous relancez le script).
2. **Pas de lien vers le manifeste ni de service worker enregistré** dans `index.html` : ajoutés.
3. **Mises à jour qui n'arrivaient pas** : l'ancien `sw.js` gardait les scripts en cache « d'abord ». Désormais : réseau d'abord pour scripts/styles/JSON, cache d'abord pour images/polices seulement.
4. **`index.html` et `config.js` mis en cache 1 jour** : `express.static` répondait avant vos routes « no-cache », qui n'étaient donc jamais exécutées. Corrigé (`index: false` + `setHeaders`).
5. **Dossier entier publié** (`express.static(__dirname)`) : `server.js`, `package.json` et `node_modules` étaient téléchargeables. Bloqués. Mieux : déplacer les fichiers publics dans un dossier `public/` et servir uniquement celui-ci.
6. **Images trop lourdes** pour un pré-cache mobile (2,5 Mo) : allégées.

## Mise en ligne (Render)
1. Copiez les fichiers, `git commit`, `git push` (Render redéploie). HTTPS est déjà fourni par Render : indispensable pour l'installation.
2. Variables d'environnement inchangées (aucune nouvelle clé).
3. Après déploiement, ouvrez l'URL **en navigation privée** la première fois (évite l'ancien cache).

## Tester
- **Android (Chrome)** : ouvrir le site → bannière « Installer » (ou menu ⋮ → Installer l'application) → l'icône Révisio apparaît sur l'écran d'accueil → lancer : plein écran, sans barre d'adresse.
- **iPhone (Safari uniquement)** : bouton Partager → « Sur l'écran d'accueil ». Pas d'invitation automatique sous iOS : une bulle explique la manipulation.
- **Ordinateur** : Chrome → F12 → onglet *Application* → *Manifest* (icônes, installabilité) et *Service Workers*. Lighthouse → catégorie *PWA*.
- **Hors ligne** : mode avion, rouvrir l'app → page « Pas de connexion ».
- Raccourcis (appui long sur l'icône Android) : Créer / Bibliothèque / Cours ouvrent l'onglet voulu une fois connecté.

## Limites à connaître
- **Il faut internet** : tests, cours et progression viennent de Supabase ; hors ligne, seule la page d'attente s'affiche. Un vrai mode hors ligne serait un chantier à part.
- Après un changement de `sw.js`/des fichiers du shell, incrémentez `APP_VERSION` dans `sw.js`.
- `index.html` charge `config.js` et le logo via l'adresse absolue `https://compotestsaas.onrender.com` : en test local, ils viennent du site en ligne.
- `viewport` avec `user-scalable=no` empêche de zoomer (accessibilité) : à retirer si possible.
- CORS : le serveur renvoie n'importe quelle origine avec `Allow-Credentials: true`. Sans risque tant que l'authentification passe par l'en-tête `Authorization` (pas de cookie), mais à restreindre à votre liste `ALLOWED_ORIGINS`.
- **Non testé** : sur un vrai téléphone, avec Lighthouse, ni sous iOS. Vérifié : syntaxe, démarrage du serveur, en-têtes, présence des balises, fichiers d'icônes.

## Et ensuite ? (application « Play Store » / APK)
La PWA suffit pour installer l'app depuis le navigateur. Pour une vraie fiche Play Store : *PWABuilder* ou *Bubblewrap* (Trusted Web Activity) à partir de l'adresse HTTPS, ou *Capacitor* (votre CORS autorise déjà `capacitor://localhost`). Cela se construit avec Android Studio sur votre PC : je ne peux pas produire l'APK ici.
