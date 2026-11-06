# Arbor

Arbor est un client Git graphique pour bureau (Windows, macOS, Linux) : graphe de commits, branches, indexation, diff, fusion, rebase, stash et résolution de conflits, le tout à la souris.

![Graphe des commits](docs/graphe.png)

## Démarrer

Prérequis : Node.js 20+ et Git installé sur la machine.

```bash
npm install
npm run dev            # mode développement (rechargement à chaud)
npm start              # build puis lancement
npm start -- /chemin/vers/un/depot   # ouvre directement un dépôt
npm test               # tests unitaires
```

## Fonctionnalités (v0.2)

- **Dépôts** : ouvrir, initialiser, cloner, liste des dépôts récents.
- **Graphe** : toutes les branches, couleurs par ligne, badges de branches/tags/remotes, défilement virtualisé, navigation au clavier.
- **Recherche dans l'historique** (Ctrl+F) : par message, auteur, préfixe de SHA ou fichier modifié, insensible à la casse et aux accents (le mode Fichier ignore la casse ASCII mais pas les accents) ; correspondances mises en évidence, navigation Entrée / Maj+Entrée.
- **Modifications en cours** : indexer/désindexer fichier par fichier ou tout, annuler des modifications, commit avec résumé + description, modification du dernier commit (amend).
- **Diff** : vue unifiée ou côte à côte, pour le répertoire de travail comme pour n'importe quel commit.
- **Indexation partielle** : depuis le diff, indexer, désindexer ou annuler un bloc entier, ou seulement les lignes sélectionnées (clic sur le numéro, Maj+clic pour une plage).
- **Branches** : checkout (double-clic), création, suppression, suivi automatique des branches distantes.
- **Remotes** : fetch, pull, push (avec publication d'une nouvelle branche), compteurs en avance/en retard.
- **Rafraîchissement automatique** : l'interface suit les changements faits hors d'Arbor (terminal, éditeur), fichiers ignorés exclus, sans boucle ; interrupteur « Auto » dans la barre d'outils.
- **Fusion et rebase** depuis le menu contextuel d'une branche, avec bandeau Continuer/Abandonner.
- **Conflits** : vue dédiée qui met en évidence les deux versions, « garder ma version » / « garder leur version ».
- **Stash** : mettre de côté, appliquer, pop, supprimer.
- **Commits** : cherry-pick, revert, reset soft/mixed/hard, tag, branche depuis un commit, copie du SHA.
- **Historique d'un fichier et blame** : clic droit sur un fichier, liste des commits qui l'ont modifié (renommages suivis) avec le diff de chaque version, blame ligne par ligne (lignes non commitées comprises) qui renvoie vers les commits.
- **Palette de commandes** (Ctrl/Cmd+Maj+P ou Ctrl/Cmd+K) : recherche floue, insensible aux accents, sur les commandes (fetch, pull, push, commit, stash, nouvelle branche, continuer/abandonner…), les branches et tags, les dépôts récents et les fichiers modifiés ; préfixes `>` commandes, `@` branches, `#` fichiers ; seules les commandes possibles dans l'état du dépôt sont proposées.

![Résolution de conflits](docs/conflits.png)

## Architecture

| Dossier | Rôle |
| --- | --- |
| `src/main` | Processus principal Electron. `git.ts` appelle le binaire `git` et analyse sa sortie ; `watcher.ts` surveille le dépôt. |
| `src/shared` | Types partagés, contrat de l'API exposée au rendu, et fonctions pures utilisées des deux côtés (`diff.ts`, `patch.ts`). |
| `src/renderer` | Interface React. `graph.ts` calcule la disposition du graphe, `diff.ts` analyse les patchs. |

Le rendu n'a aucun accès direct au système : toutes les commandes passent par l'IPC (`window.arbor`).

## Feuille de route

1. Palette de commandes et raccourcis, thème clair et préférences, onglets pour plusieurs dépôts.
2. Rebase interactif (glisser-déposer), éditeur de fusion à trois panneaux, gestion des remotes et des tags, annulation via le reflog.
3. Authentification GitHub/GitLab, pull requests, identifiants SSH/HTTPS.
4. Performances sur gros dépôts, tests de bout en bout en CI, paquets d'installation (electron-builder).
