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
- **Éditeur de fusion à trois panneaux** : fusion calculée par Git (`git merge-file --diff3`, filtres du dépôt appliqués), ma version, base et leur version alignées bloc par bloc, résultat modifiable en bas (un segment par bloc), changements sans conflit appliqués d'office, choix par conflit (ma version, leur version, les deux, base), Alt+↑/↓ et Alt+1/2/3 (aussi dans la palette), défilement synchronisé ; « ma version » reste la vôtre pendant un rebase (pas d'inversion pendant `git am`) ; fins de ligne CRLF, saut final et bit exécutable conservés, écriture atomique ; avertissement si le fichier a déjà été modifié (résolution commencée ailleurs, rerere) ; enregistrement refusé si le fichier a changé pendant l'édition ; conflits suppression/modification (garder ou supprimer le fichier). Repli sur la vue simple pour les fichiers binaires, filtrés (LFS…), de plus de 1 Mo, 20 000 lignes ou 2 000 blocs, les sous-modules et les liens symboliques.
  Les brouillons de l'éditeur restent en mémoire seulement : ils survivent au changement d'onglet ou de fichier, pas à la fermeture d'Arbor.
- **Stash** : mettre de côté, appliquer, pop, supprimer.
- **Commits** : cherry-pick, revert, reset soft/mixed/hard, tag, branche depuis un commit, copie du SHA.
- **Historique d'un fichier et blame** : clic droit sur un fichier, liste des commits qui l'ont modifié (renommages suivis) avec le diff de chaque version, blame ligne par ligne (lignes non commitées comprises) qui renvoie vers les commits.
- **Thème clair et préférences** (Ctrl/Cmd+, ou engrenage) : thème clair, sombre ou celui du système, taille du code des diffs, police à chasse fixe (code, diffs, blame, identifiants de commit), mode de diff par défaut, rafraîchissement automatique, réouverture des onglets ; enregistrées immédiatement et conservées au redémarrage, sans flash sombre au lancement.
- **Palette de commandes** (Ctrl/Cmd+Maj+P ou Ctrl/Cmd+K) : recherche floue, insensible aux accents, sur les commandes (fetch, pull, push, commit, stash, nouvelle branche, continuer/abandonner…), les branches et tags, les dépôts récents et les fichiers modifiés ; préfixes `>` commandes, `@` branches, `#` fichiers ; seules les commandes possibles dans l'état du dépôt sont proposées.
- **Onglets multi-dépôts** : un onglet par dépôt (Ctrl/Cmd+T, Ctrl/Cmd+W, Ctrl+Tab / Ctrl+Maj+Tab, clic du milieu), chaque onglet garde sa sélection, son diff et son brouillon de commit ; seul l'onglet actif est surveillé ; onglets rouverts au redémarrage (préférence « restaurer les onglets »), dépôts supprimés écartés, dépôts momentanément inaccessibles (disque externe, partage réseau) gardés et rouverts au lancement suivant ; dépôts de même nom distingués par leur dossier parent.

![Résolution de conflits](docs/conflits.png)

## Architecture

| Dossier | Rôle |
| --- | --- |
| `src/main` | Processus principal Electron. `git.ts` appelle le binaire `git` et analyse sa sortie ; `watcher.ts` surveille le dépôt. |
| `src/shared` | Types partagés, contrat de l'API exposée au rendu, et fonctions pures utilisées des deux côtés (`diff.ts`, `patch.ts`). |
| `src/renderer` | Interface React. `graph.ts` calcule la disposition du graphe, `diff.ts` analyse les patchs. |

Le rendu n'a aucun accès direct au système : toutes les commandes passent par l'IPC (`window.arbor`).

## Feuille de route

1. Onglets : conserver aussi l'état propre aux composants (défilement du graphe, recherche, panneaux repliés), aujourd'hui remis à zéro à chaque activation.
2. Rebase interactif (glisser-déposer), gestion des remotes et des tags, annulation via le reflog.
3. Authentification GitHub/GitLab, pull requests, identifiants SSH/HTTPS.
4. Performances sur gros dépôts, tests de bout en bout en CI, paquets d'installation (electron-builder).
