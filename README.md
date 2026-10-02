# Nineteen J Store

PWA "App Store" pour les applications Web & Mobile de **Nineteen J Games**. Vitrine publique + panneau admin sécurisé.

## Architecture - 100% gratuit, aucun backend

```
Firebase Hosting (public/, forfait Spark gratuit)         Firebase Auth (gratuit)
┌─────────────────────┐                                    ┌───────────┐
│ index.html (vitrine) │──lecture publique (clé publishable)│ Email/PW  │
│ app/detail.html      │                                     │ Google    │
│ admin/index.html     │──écriture (token Firebase = JWT)───▶│           │
└──────────────────────┘                                    └─────┬─────┘
                                                                    │ ID token
                                                                    ▼
                                                          ┌──────────────────────┐
                                                          │ Supabase             │
                                                          │ Third-Party Auth :   │
                                                          │ vérifie le token     │
                                                          │ Firebase lui-même    │
                                                          │ RLS → private.       │
                                                          │ is_admin() autorise  │
                                                          │ l'écriture si        │
                                                          │ profiles.role=admin  │
                                                          └──────────────────────┘
```

**Pas de Cloud Function.** Au départ, ce projet prévoyait une Cloud Function comme
intermédiaire - mais Cloud Functions exige le forfait **Blaze** (facturation activée),
même si l'usage réel reste gratuit. Pour rester 100% Spark (gratuit), le panneau admin
utilise directement le **token Firebase comme JWT Supabase** (fonctionnalité native
*Third-Party Auth*) : Supabase vérifie ce token lui-même, et les **policies RLS**
(`private.is_admin()`) autorisent l'écriture uniquement si le compte a `role='admin'`
dans la table `profiles`. Aucune clé secrète n'est jamais présente côté client.

## Stack

- **Hosting** : Firebase Hosting (Spark, gratuit)
- **Auth** : Firebase Authentication - Email/Password + Google (gratuit)
- **Données & fichiers** : Supabase (Postgres + Storage), tier gratuit, RLS pour toute
  l'autorisation
- **Frontend** : HTML/CSS/JS vanilla (ES modules), Tailwind **compilé en local** (`npm run build:css`),
  Lucide Icons et supabase-js **vendorisés** dans `public/js/vendor/` (versions figées, empreintes SHA-256
  dans `SHA256SUMS.txt`) - plus aucun script chargé depuis un CDN tiers, hors SDK Firebase (gstatic.com)
- **PWA** : Web App Manifest + Service Worker (stale-while-revalidate pour l'app shell,
  network-first pour les données)

## Installation

```bash
npm install -g firebase-tools
firebase login
firebase use --add        # sélectionner ton projet Firebase, alias "default"
```

### 1. Configurer Firebase (client)

Dans `public/js/firebase-config.js`, remplace les valeurs `TODO_*` par celles de
**Console Firebase > Paramètres du projet > Vos applications > Config SDK**.

Active les providers **Email/Password** et **Google** dans **Authentication > Sign-in method**.

### 2. Enregistrer Firebase comme fournisseur tiers dans Supabase (une seule fois)

C'est l'étape qui remplace le backend :

1. Dashboard Supabase du projet `nineteen-j-store` → **Authentication > Sign In / Providers
   > Third-Party Auth**.
2. Ajouter une intégration **Firebase Auth**, renseigner ton **Firebase Project ID**
   (Console Firebase > Paramètres du projet > ID du projet).
3. Enregistrer. Supabase peut désormais vérifier cryptographiquement les ID tokens émis
   par ton projet Firebase et les traiter comme des JWT valides pour `auth.jwt()`.

Aucune autre config n'est nécessaire côté Supabase : le schéma, les policies RLS et les
buckets sont déjà en place sur le projet `rrlayjervibobxiucbuu`
(voir `supabase/migrations/20260927_init_store_schema.sql`).

### 3. Promouvoir le premier administrateur

1. Connecte-toi une première fois sur `/admin/index.html` **avec Google**. La première
   connexion crée automatiquement un profil `role='user'` dans Supabase (la policy exige que
   l'email du profil soit celui du jeton Firebase : il n'est plus falsifiable).
2. Récupère ton **UID** : Console Firebase > Authentication > Users > colonne "User UID".
3. Dans le **SQL Editor** de Supabase, promeus **par UID** (jamais par email) :
   ```sql
   update public.profiles set role = 'admin' where firebase_uid = '<TON_UID>';
   ```
4. Recharge `/admin/index.html` - l'accès est débloqué.

### 4. Gestes manuels de sécurité (hors code)

- Firebase Console > Authentication > Sign-in method : **désactiver Email/Password** (garder Google).
- Activer la **validation en 2 étapes** sur le compte Google admin.
- Google Cloud Console > Identifiants : **restreindre la clé API Firebase** aux referrers de ton
  domaine (`https://nineteen-j-store.web.app/*`, `https://nineteen-j-store.firebaseapp.com/*`).
- Firebase Auth > Settings > **Domaines autorisés** : uniquement tes domaines.

## Exécution locale

```bash
npm install            # outillage de build uniquement (Tailwind), aucune dépendance runtime
npm run build:css      # régénère public/assets/css/tailwind.css (à relancer si tu changes des classes)
firebase emulators:start --only hosting
# http://localhost:5000
```

Le panneau admin parle directement à Supabase (pas d'émulateur nécessaire côté données) ;
Firebase Auth fonctionne aussi en pointant vers le vrai projet (pas besoin de l'émulateur
Auth pour ce projet, sauf si tu veux tester hors-ligne des comptes fictifs).

## Tests

Le projet n'a pas encore de suite de tests automatisés. Recommandé avant toute PR non
triviale :

```bash
npx eslint public/js --ext .js
```

Pistes d'amélioration : Playwright pour un test end-to-end (login admin → créer une app →
vérifier son affichage sur la vitrine), et un test RLS direct (`execute_sql` avec un JWT
de test signé pour un compte non-admin, vérifier que l'écriture est bien refusée).

## Déploiement

```bash
npm run build:css && firebase deploy --only hosting
```

Le pipeline GitHub Actions (`.github/workflows/deploy.yml`) : vérifie la syntaxe JS et les
empreintes des scripts vendorisés, compile le CSS, lance `npm audit`, puis déploie sur `main`
via un **compte de service** (secrets du dépôt : `FIREBASE_SERVICE_ACCOUNT` = JSON du compte
de service au rôle *Firebase Hosting Admin*, `FIREBASE_PROJECT_ID`, `HOSTING_URL`). Les actions
sont épinglées par SHA de commit. Active la protection de branche sur `main` et, si tu veux une
validation manuelle avant chaque déploiement, une règle d'approbation sur l'environnement
`production` (Settings > Environments).

### En-têtes de sécurité et CSP

`firebase.json` applique `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`,
HSTS et une CSP **partielle appliquée** (`frame-ancestors 'none'; base-uri; object-src; form-action`).
La CSP **complète** est livrée en `Content-Security-Policy-Report-Only` : après déploiement,
ouvre le site, la fiche d'une app et `/admin` (connexion Google incluse) avec la console du
navigateur ouverte. S'il n'y a aucun message `[Report Only] Refused to ...`, remplace dans
`firebase.json` la clé `Content-Security-Policy-Report-Only` par `Content-Security-Policy` (et
supprime la version partielle). Sinon, ajoute la source signalée à la directive concernée.

### Rollback

```bash
firebase hosting:clone <site>:<version-précédente> <site>:live
```

Aucune fonction serveur à gérer : le rollback se limite à Hosting (fichiers statiques).

## Variables d'environnement / config

| Où | Variable | Description |
|---|---|---|
| Client (non secret) | `public/js/firebase-config.js` | Config publique Firebase Web SDK |
| Client (non secret) | `public/js/supabase-config.js` | URL + clé `publishable` Supabase (lecture seule via RLS) |
| Supabase Dashboard | Third-Party Auth > Firebase | Project ID Firebase (voir étape 2 ci-dessus) |

Rien n'est secret côté client : la sécurité repose entièrement sur (1) la vérification
cryptographique du token Firebase par Supabase et (2) les policies RLS.

## Audit de sécurité (2026-10-01) - état des findings

| # | Sujet | État |
|---|---|---|
| H1 | Scripts tiers / pas de CSP | **Corrigé côté code** : Tailwind compilé, Lucide + supabase-js + tus vendorisés (versions figées, SHA-256 vérifiés en CI), scripts/styles inline externalisés, en-têtes + CSP dans `firebase.json`. **À finaliser** : passer la CSP de `Report-Only` à enforcée après vérification en console (voir Déploiement). |
| H2 | Escalade admin via email de profil | **Corrigé** : email unique + policy exigeant `email = jwt.email`, promotion par UID. Vérifié en prod : 1 seul admin, aucun doublon. |
| M1 | Notes/téléchargements falsifiables | **Atténué** : plafond global par minute/jour dans les RPC (protège le quota gratuit). Le « 1 par appareil » reste indicatif (device_id déclaratif). |
| M2 | Commentaires : comptes jetables, identité libre | **Corrigé** : policy exigeant Google + email vérifié + `author_uid = jwt.sub`. |
| M3 | Données non publiées lisibles | **Corrigé** : statut `draft` par défaut, lecture publique des versions/captures/avis conditionnée à `published`, bouton Publier/Dépublier dans l'admin. |
| M4 | En-têtes absents | **Corrigé** (voir H1). |
| M5 | Admin mot de passe seul | **Partiel** : formulaire mot de passe retiré (Google uniquement). **À faire à la main** : désactiver Email/Password dans Firebase, activer la 2FA Google (voir Installation §4). |
| M6 | CI fragile | **Corrigé côté dépôt** : actions épinglées par SHA, compte de service, étapes bloquantes. **À faire à la main** : créer le compte de service et les secrets GitHub, protéger `main`. |
| B1 | URLs non validées | **Corrigé** : contraintes `https://` en base. |
| B2 | MIME / intégrité des APK | **MIME corrigé** (liste volontairement large pour les APK). **Non fait** : publication d'un SHA-256 par version. |
| B3 | Service Worker | **Corrigé** : réseau d'abord pour le code, requêtes authentifiées jamais interceptées. |
| B4 | `onclick` inline | **Corrigé**. |
| B5 | Intégrité de `tus.min.js` | **Vérifié** : empreinte identique à celle publiée par le registre npm (`dist.integrity`). |
| B6 | Migrations vs prod | **Vérifié** : pas d'écart sur `private` (aucun `USAGE` accordé, et ça fonctionne, en prod comme en migration). Le fichier « sync » reste une reconstitution : exporter `pg_policies` de temps en temps. |

## Changements suite à des modifications faites à la main sur Supabase (2026-09-30)

Ces changements ont été faits directement en base (Dashboard/SQL Editor) puis
répercutés dans le code - gardés ici pour référence :

- **Commentaires réservés aux visiteurs connectés.** La policy RLS exige désormais un
  compte Firebase authentifié (Google) pour poster un avis - anti-spam. La fiche
  publique affiche un bouton "Se connecter avec Google" si besoin ; ce n'est **pas**
  un compte admin, n'importe quel visiteur peut se connecter pour commenter.
- **Téléchargements dédupliqués.** `increment_download_count` n'incrémente plus qu'une
  fois par appareil et par jour (table `app_download_events`), au lieu de compter
  chaque clic.
- **`apps.website_url`** : lien "Site web" optionnel, affiché sur la fiche publique.
- **`categories.display_order`** : les catégories s'affichent dans l'ordre choisi dans
  le panneau admin (boutons ↑/↓), plus seulement par ordre alphabétique.
- **Une seule version "courante" par app** appliquée par trigger SQL
  (`single_current_version`), plus besoin de le gérer côté client.
- **Limites de taille des buckets** : 5 Mo pour icônes/captures, 50 Mo pour les
  APK/ZIP - vérifiées côté client avant upload pour un message d'erreur clair.

## Panneau admin - flux de publication

1. **Créer l'application** (infos de base) → obtient un identifiant.
2. La section média apparaît alors : **icône**, **captures d'écran**, **versions**.
   Chaque élément s'enregistre en base **immédiatement** dès l'upload réussi - il n'y a
   plus d'état en mémoire qui peut se perdre si tu fermes le panneau trop tôt.
3. Une application n'est **téléchargeable** que si au moins une version a un fichier
   (APK/ZIP) ou une URL externe. Le numéro de version est donc obligatoire ; sans
   version, la fiche publique affiche "Bientôt disponible" au lieu d'un bouton mort.

## Buckets Supabase Storage

| Bucket | Contenu | Accès |
|---|---|---|
| `app-icons` | Icônes des applications | Lecture publique, écriture admin uniquement (RLS) |
| `app-screenshots` | Captures d'écran | Idem |
| `app-binaries` | APK / ZIP / archives | Idem |

Upload : icône et captures passent par `createSignedUploadUrl` + `uploadToSignedUrl`
(méthode standard Supabase, adaptée aux petits fichiers). Le fichier d'application
(APK/ZIP) passe par le **protocole TUS** (upload reprenable, blocs de 6 Mo, retry
automatique) via `tus-js-client`, vendorisé localement dans `public/js/vendor/`
(pas de CDN tiers, pour éviter les blocages "Tracking Prevention" de certains
navigateurs) - recommandation officielle Supabase au-delà de 6 Mo.

**Si un upload de gros fichier échoue avec `ERR_HTTP2_PROTOCOL_ERROR`** malgré les
tentatives automatiques (jusqu'à 7, avec délais croissants) : c'est généralement un
antivirus ou proxy qui inspecte le trafic HTTPS et perturbe les flux HTTP/2 sur les
grosses requêtes `PATCH`. Pour confirmer : tester sur un autre réseau (ex. partage de
connexion mobile) ou un autre navigateur sans antivirus HTTPS-scanning actif. Ce n'est
pas un bug de l'application dans ce cas - c'est une interférence réseau locale.

**Bug corrigé (2026-10-01) : lien de téléchargement mort (404) après un upload
pourtant réussi.** `uploadBinaryResumable()` appelait `findPreviousUploads()` +
`resumeFromPreviousUpload()` : si le même fichier (nom+taille+date identiques) avait
déjà été tenté une fois (même en échec), tus-js-client reprenait l'upload stocké sous
l'**ancien** nom aléatoire généré lors de cette tentative précédente - alors que le
code enregistrait en base le **nouveau** nom généré pour cet essai. Résultat : le
fichier existait bien dans Supabase Storage, mais sous un nom différent de celui
enregistré en base → 404. Corrigé en désactivant la reprise inter-session
(`upload.start()` direct, `storeFingerprintForResuming: false`) ; la résilience
réseau reste assurée par les tentatives automatiques (`retryDelays`) au sein d'un
même upload en cours.
