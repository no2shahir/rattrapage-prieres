# Rattrapage des prières (PWA)

Même design et mêmes fonctions qu'avant, avec compte (email + mot de passe), sauvegarde en ligne Supabase, mode hors ligne et installation sur iPhone.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | La page et tout le design (inchangé) |
| `app.js` | Le code de l'app + connexion + synchronisation |
| `config.js` | URL et clé publique Supabase (à remplir) |
| `manifest.json` | Rend l'app installable |
| `sw.js` | Service worker : ouverture hors ligne |
| `supabase.sql` | Crée la table et les règles de sécurité (RLS) |
| `icons/` | Icônes de l'app (4 images PNG) |

## 1. Créer le projet Supabase (gratuit)

1. Va sur supabase.com, crée un compte puis un projet (plan Free).
2. **SQL Editor** > New query > colle le contenu de `supabase.sql` > Run.
3. **Authentication > Providers > Email** : laisse l'email activé. Pour un usage perso, tu peux désactiver "Confirm email" (connexion immédiate après inscription).
4. **Project Settings > API** : copie *Project URL* et la clé **anon / publishable**. Ne copie jamais la clé `service_role` ou `secret`.
5. Colle les deux valeurs dans `config.js`.

## 2. Publier sur GitHub Pages

1. Crée un dépôt GitHub et mets-y tous les fichiers de ce dossier (à la racine du dépôt, avec le dossier `icons`).
2. **Settings > Pages** : Source = branche `main`, dossier `/ (root)` > Save.
3. Ton adresse sera `https://TON-PSEUDO.github.io/NOM-DU-DEPOT/`.
4. Dans Supabase, **Authentication > URL Configuration** : mets cette adresse dans *Site URL* et ajoute-la dans *Redirect URLs* (nécessaire pour le lien de confirmation d'email et de réinitialisation du mot de passe).

## 3. Installer sur iPhone

Ouvre l'adresse dans **Safari** > bouton Partager > **Sur l'écran d'accueil**.

## Fonctionnement

- **Sécurité** : seule la clé publique est dans le code. La table a le Row Level Security : chaque compte lit et écrit uniquement sa propre ligne (`auth.uid() = user_id`).
- **Autre appareil** : connecte-toi avec le même email, tu retrouves tout.
- **Hors ligne** : l'app s'ouvre et tu peux continuer à saisir. Les changements sont envoyés dès le retour de la connexion.
- **Conflits** : si tu modifies sur deux appareils sans connexion, les deux historiques sont fusionnés en gardant, pour chaque jour et chaque prière, le plus grand nombre (rien n'est perdu).
- **Sauvegarde manuelle** : Réglages > Sauvegarde > Exporter / Importer (fichier JSON).
- **Mettre à jour l'app** : après une modification, change `CACHE = 'qada-shell-v1'` en `v2` dans `sw.js`.
