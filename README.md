# Arbor

Arbor est un client Git graphique pour bureau (Windows, macOS, Linux) : graphe de commits, branches, indexation, diff, fusion, rebase, stash et résolution de conflits, le tout à la souris.

![Graphe des commits](docs/graphe.png)

## Démarrer

Prérequis : Node.js 20+ et Git installé sur la machine (2.27 ou plus récent).

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
- **Fusion et rebase** depuis le menu contextuel d'une branche, avec bandeau Continuer/Passer/Abandonner.
- **Conflits** : vue dédiée qui met en évidence les deux versions, « garder ma version » / « garder leur version ».
- **Éditeur de fusion à trois panneaux** : fusion calculée par Git (`git merge-file --diff3`, filtres du dépôt appliqués), ma version, base et leur version alignées bloc par bloc, résultat modifiable en bas (un segment par bloc), changements sans conflit appliqués d'office, choix par conflit (ma version, leur version, les deux, base), Alt+↑/↓ et Alt+1/2/3 (aussi dans la palette), défilement synchronisé ; « ma version » reste la vôtre pendant un rebase (pas d'inversion pendant `git am`) ; fins de ligne CRLF, saut final et bit exécutable conservés, écriture atomique ; avertissement si le fichier a déjà été modifié (résolution commencée ailleurs, rerere) ; enregistrement refusé si le fichier a changé pendant l'édition ; conflits suppression/modification (garder ou supprimer le fichier). Repli sur la vue simple pour les fichiers binaires, filtrés (LFS…), de plus de 1 Mo, 20 000 lignes ou 2 000 blocs, les sous-modules et les liens symboliques.
  Les brouillons de l'éditeur restent en mémoire seulement : ils survivent au changement d'onglet ou de fichier, pas à la fermeture d'Arbor.
- **Stash** : mettre de côté, appliquer, pop, supprimer.
- **Commits** : cherry-pick, revert, reset soft/mixed/hard, tag, branche depuis un commit, copie du SHA.
- **Historique d'un fichier et blame** : clic droit sur un fichier, liste des commits qui l'ont modifié (renommages suivis) avec le diff de chaque version, blame ligne par ligne (lignes non commitées comprises) qui renvoie vers les commits.
- **Thème clair et préférences** (Ctrl/Cmd+, ou engrenage) : thème clair, sombre ou celui du système, taille du code des diffs, police à chasse fixe (code, diffs, blame, identifiants de commit), mode de diff par défaut, rafraîchissement automatique, réouverture des onglets ; enregistrées immédiatement et conservées au redémarrage, sans flash sombre au lancement.
- **Palette de commandes** (Ctrl/Cmd+Maj+P ou Ctrl/Cmd+K) : recherche floue, insensible aux accents, sur les commandes (fetch, pull, push, commit, stash, nouvelle branche, continuer/abandonner…), les branches et tags, les dépôts récents et les fichiers modifiés ; préfixes `>` commandes, `@` branches, `#` fichiers ; seules les commandes possibles dans l'état du dépôt sont proposées.
- **Onglets multi-dépôts** : un onglet par dépôt (Ctrl/Cmd+T, Ctrl/Cmd+W, Ctrl+Tab / Ctrl+Maj+Tab, clic du milieu), chaque onglet garde sa sélection, son diff et son brouillon de commit ; seul l'onglet actif est surveillé ; onglets rouverts au redémarrage (préférence « restaurer les onglets »), dépôts supprimés écartés, dépôts momentanément inaccessibles (disque externe, partage réseau) gardés et rouverts au lancement suivant ; dépôts de même nom distingués par leur dossier parent.
- **Rebase interactif** (clic droit sur un commit « Rebase interactif à partir d'ici… », sur une branche, ou palette) : liste des commits plus récent en haut, réordonnés par glisser-déposer ou Alt+↑/↓, actions pick/reword/edit/squash/fixup/drop (touches p r e s f d), messages saisis avant de démarrer, commits déjà publiés signalés ; refusé s'il y a des modifications locales ou des fusions dans la plage. Le bandeau affiche l'étape, le commit d'arrêt (edit, conflit) et les étapes restantes, avec Continuer, Passer et Abandonner.
- **Gestion des remotes** : ajouter (URL de push facultative, fetch immédiat), renommer, supprimer (avec confirmation), modifier l'URL de fetch ou de push (valeurs brutes de la configuration, avant `insteadOf` ; push vide = même URL que le fetch), fetch ou prune d'un seul remote, copie de l'URL ; « + » et bouton Fetch dans l'en-tête des remotes, URL en infobulle, commandes de palette « Ajouter un remote… », « Fetch <remote> », « Prune <remote> ».
- **Tags** : création légère ou annotée (message multiligne) sur n'importe quel commit, avec publication immédiate facultative ; section de la barre latérale (clic = sélection du commit, double-clic = checkout de `refs/tags/<nom>`, « + » = tag sur HEAD, infobulle du message) ; menu du tag dans la barre latérale et sur les badges du graphe (checkout, pousser vers un remote, supprimer en local et sur le remote si le tag y est présent, copier le nom) ; palette : « Créer un tag… », « Pousser tous les tags vers <remote> ».
- **Annulation par le reflog** : bouton Annuler de la barre d'outils (et palette « Annuler la dernière opération ») qui ramène la branche extraite à son état précédent d'après son reflog, après confirmation : `reset --soft` après un commit ou un amend (les changements restent indexés), `reset --keep` après une fusion, un pull, un rebase, un reset, un cherry-pick ou un revert (modifications locales conservées, refus de Git si elles seraient écrasées) ; refusé en HEAD détachée, pendant une opération ou si la branche a changé depuis l'affichage ; les commits retirés restent dans le reflog (Annuler à nouveau rétablit l'état). Palette « Afficher le reflog… » : reflog de la branche ou de HEAD par pages de 200, date de chaque opération, retour à n'importe quel état par « Reset (keep) » avec confirmation. Pas de Ctrl+Z.
- **Sous-modules** : section de la barre latérale (présente avec un `.gitmodules`) avec l'état de chacun (à jour, autre commit extrait, non initialisé, en conflit, absent de l'index, modifications non commitées) ; initialiser un sous-module ou tous ceux qui manquent (sans jamais déplacer un sous-module déjà initialisé), revenir au commit attendu (confirmé, sans toucher aux sous-modules imbriqués), synchroniser les URL, ouvrir un sous-module dans un nouvel onglet (double-clic) ; dans le diff, une carte « Sous-module : abc1234 → def5678 » remplace les blocs (pas d'indexation partielle) ; badge « sous-module » dans les modifications en cours. Arbor ne modifie jamais `protocol.file.allow` : un sous-module local à cloner s'initialise depuis un terminal. Limite : un commit fait dans un sous-module hors d'Arbor n'est vu qu'au prochain rafraîchissement (focus, bouton).
- **Git LFS** : section de la barre latérale (présente si le dépôt utilise LFS, repliée par défaut) avec les motifs suivis ou exclus et, chargés seulement à l'ouverture, les fichiers LFS (taille, « pointeur seul » quand le contenu n'est pas récupéré, au plus 1 000) ; suivre un motif (« + », écrit dans `.gitattributes`), ne plus suivre un motif (confirmé), récupérer un fichier (double-clic sur un pointeur seul) ou tous (`git lfs pull`), télécharger les objets (`git lfs fetch`, palette) ; dans le diff, une carte « Fichier LFS : 19,5 Ko → 21,0 Ko » (empreintes, « Voir le pointeur ») remplace le diff du pointeur (pas d'indexation partielle) ; badges « LFS » et « sera stocké dans LFS » (fichier non suivi correspondant à un motif) dans les modifications en cours. Sans git-lfs : motifs lus dans le `.gitattributes` racine, bandeau d'avertissement, actions LFS désactivées et message clair quand Git a besoin du filtre. Hors périmètre : verrous, `migrate`, `prune`.

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
2. Authentification GitHub/GitLab, pull requests, identifiants SSH/HTTPS.
3. Performances sur gros dépôts, tests de bout en bout en CI, paquets d'installation (electron-builder).
