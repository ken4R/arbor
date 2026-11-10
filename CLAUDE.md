# Arbor — guide pour les agents

Arbor est un client Git graphique de bureau (Electron + React + TypeScript), inspiré par l'ergonomie des clients Git visuels mais avec son propre nom, son propre design et ses propres assets. Ne reprenez jamais le nom, le logo, les couleurs ou les textes d'un produit existant (GitKraken compris).

## Langue

- Interface, messages d'erreur, commentaires de code, messages de commit et descriptions de PR : **en français**.
- Noms d'identifiants (variables, fonctions, fichiers) : en anglais.

## Architecture

| Dossier | Rôle |
| --- | --- |
| `src/main/git.ts` | **Seul** endroit qui exécute `git` (via `execFile`, jamais via un shell). Fonctions d'analyse pures (`parseStatus`, `parseLog`…) testées unitairement. |
| `src/main/main.ts` | Fenêtre Electron, dialogues natifs, enregistrement des handlers IPC `arbor:<méthode>`. |
| `src/main/watcher.ts` | Surveillance du dépôt (dossier Git et arbre de travail), regroupement des événements, mise en sourdine pendant les commandes IPC. N'exécute pas `git` lui-même (passe par `git.ts`). |
| `src/main/preload.ts` | Expose `window.arbor.call` et `window.arbor.on` (événements poussés par le processus principal, liste blanche) au rendu (contextIsolation activé). |
| `src/shared/` | `types.ts` : types partagés et interface `ArborApi`, le contrat entre rendu et processus principal. Fonctions pures utilisées des deux côtés (`diff.ts`, `patch.ts`). |
| `src/shared/prefs.ts` | Préférences (`Preferences`, `DEFAULT_PREFERENCES`, `normalizePreferences`) stockées par le main dans `userData/prefs.json` (`getPreferences`/`setPreferences`), jamais dans localStorage. Côté rendu : `src/renderer/prefs.ts` (`usePreferences`, `updatePreferences`). |
| `src/renderer/commands.ts` | Registre de commandes consommé par la palette (`registerCommands`, `getCommands`, `setCommandContext`, `matchShortcut`). Toute nouvelle action utilisateur y ajoute une commande dans `commands/<domaine>.ts`. Actions Git réutilisables (barre d'outils, palette) dans `actions.ts`. |
| `src/renderer/` | UI React. `graph.ts` = disposition du graphe, `diff.ts` = analyse des patchs, `actions.ts` = menus contextuels, `ui.ts` = contexte (`run`, `ask`, `openMenu`, `showDiff`). |

Règles :
- Le rendu n'accède jamais au système de fichiers ni à `child_process` : tout passe par `ArborApi`.
- Toute opération Git déclenchée par l'UI passe par `ui.run(label, fn, succès?)`, qui gère l'indicateur, les erreurs et le rafraîchissement.
- Pas de `window.prompt/confirm` (non supportés par Electron) : utiliser `ui.ask`.
- Dialogue spécifique (plusieurs champs) : `ui.openDialog((close) => <MonDialogue …/>)` avec la coquille `components/Dialog.tsx` (porte `data-overlay`). `ui.ask` reste la voie pour une confirmation ou un champ unique.
- Barre latérale : `Sidebar.tsx` (filtre commun) assemble les sections de `components/sidebar/` (`LocalBranchesSection`, `RemotesSection`, `TagsSection`, `StashesSection`…), toutes de signature `{ snap, match, onSelectCommit }` (`Section.tsx` : en-tête repliable avec `id` stable — `local`, `remote:<nom>`, `remotes`, `tags`, `stashes`, `submodules`, `lfs` —, `actions` et `onContextMenu`). Une nouvelle section = un fichier dans `sidebar/`.
- `RepoSnapshot.features` (`submodules`, `lfs`) est détecté par `repoFeatures` dans `snapshot()` à partir des fichiers seuls (`.gitmodules`, `.gitattributes` racine via `hasLfsAttribute`, `<gitDir>/lfs`), sans lancer `git` : une fonctionnalité absente du dépôt ne coûte aucune commande par rafraîchissement.
- Les opérations destructrices (reset hard, suppression de branche, annulation de modifications) demandent une confirmation.
- Toute commande IPC absente de la liste `READ_ONLY` de `main.ts` s'exécute sous `watcher.mute()` : une action d'Arbor ne déclenche jamais de rafraîchissement automatique. N'ajoutez à `READ_ONLY` qu'une commande qui n'écrit rien dans `.git` (attention : `git diff` peut réécrire l'index).
- Les lectures (`status`) utilisent `--no-optional-locks` ; `diff()` force `--no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/` pour ne pas dépendre de la configuration de l'utilisateur.
- Un patch partiel est toujours construit dans le processus principal, à partir d'un diff recalculé et comparé à celui affiché.
- Couleurs et espacements : variables CSS de `styles.css` (`--bg`, `--accent`…), pas de valeurs en dur dans les composants ni dans les règles CSS. Toute couleur nouvelle = variable définie dans le thème sombre ET le thème clair.
- Handlers IPC qui ne reçoivent pas de dépôt en premier argument : à ajouter à `NO_REPO` dans `main.ts`.
- Surcouches (dialogue, menu, palette…) : attribut `data-overlay` sur leur élément racine ; Échap ne ferme pas le diff ni la vue fichier tant qu'une surcouche est ouverte.
- `ARBOR_USER_DATA` isole les données utilisateur (préférences, dépôts récents) ; `scripts/ui-check.cjs` utilise un dossier temporaire neuf à chaque lancement, sauf avec `--keep-user-data[=<dossier>]` (scénarios de redémarrage).
- Onglets : `App` est la coquille (barre d'onglets, onglet vide = `Welcome`, restauration de session) et `RepoView` affiche un dépôt. Un seul `RepoView` est monté (`key` = identifiant de l'onglet) et seul son dépôt est surveillé. L'état par onglet (sélection, diff, vue fichier, brouillon, dernier instantané) vit dans `tabs.ts` ; la session dans `userData/session.json` (`restoreSession`/`saveSession`). Changer ou fermer d'onglet est bloqué pendant une opération `ui.run`. Le menu de l'application n'a ni « Fermer » ni « Recharger » : Ctrl/Cmd+W appartient aux onglets.
- Rebase interactif : `GIT_SEQUENCE_EDITOR` est la seule commande que Git exécute via un shell ; c'est une chaîne constante (`cp "$ARBOR_REBASE_TODO"`), toute donnée passe par variable d'environnement ou fichier dans `<gitDir>/arbor-rebase/`. Les messages (reword/squash) sont appliqués par des lignes `exec git commit --amend -F "$(git rev-parse --git-path …)"`. Fonctions pures dans `src/shared/rebase.ts` (`buildTodo`, `validateSteps`, `progressFromFiles`) ; bandeau d'opération dans `components/OperationBanner.tsx`.
- Sous-modules : ne jamais lancer `git` dans le dossier d'un sous-module sans avoir vérifié que `<chemin>/.git` existe. Ne jamais modifier `protocol.*.allow`. `diff()` force aussi `--submodule=short`. Un chemin de sous-module reçu du rendu est revérifié contre la liste recalculée (`requireSubmodule`). Liste partagée par le magasin `renderer/submodules.ts` (`useSubmodules`) ; diffs sans lignes à indexer (sous-module, puis LFS) : carte générique `DiffCard` de `DiffView.tsx`.
- LFS : git-lfs est facultatif (`lfsInfo().installed`) ; sans lui, `snapshot` relit le statut sans le filtre LFS (`statusWithoutLfs`, seulement si git-lfs est introuvable) et les actions LFS sont refusées. Les motifs sont toujours lus en Node dans le `.gitattributes` racine : jamais `git lfs track` en lecture (il installe des hooks et écrit `.git/config`). `git lfs ls-files` n'est jamais appelé dans `snapshot` (`lfsFiles`, à l'ouverture de la section, hors `READ_ONLY` car il peut ajouter `lfs.repositoryformatversion` à `.git/config`). Motif validé (`lfsPatternError`) et toujours après `--` ; `lfsPull` ne passe à `--include` que des fichiers LFS connus sans caractère de motif (`lfsPullArgs` : homonymes exclus, sans préfixe `/`, ignoré par git-lfs 3.8). `applyPatchSelection` refuse tout fichier dont `filter` vaut `lfs` ; `diff()` force `-U3`. Fonctions pures dans `src/shared/lfs.ts`, magasin `renderer/lfs.ts`. Diffs de pointeurs LFS et de sous-modules : carte dédiée, pas d'indexation partielle. `scripts/ui-check.cjs --path-without-lfs` simule un poste sans git-lfs.

## Commandes

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (fonctions pures : git.ts, graph.ts, diff.ts)
npm run build       # main (esbuild) + renderer (vite)
npm run dev         # développement avec rechargement
npm start -- <dépôt>
```

Pour voir l'app tourner sans écran : skill `run-arbor`. Pour un dépôt de test réaliste : skill `demo-repo`.

## Définition de « terminé »

1. `npm run typecheck` et `npm test` passent (le hook Stop les lance).
2. Toute nouvelle fonction d'analyse a un test dans le fichier `*.test.ts` voisin.
3. Un changement visible a été vérifié dans Electron avec le skill `run-arbor` (captures d'écran regardées).
4. Le `README.md` (liste des fonctionnalités, feuille de route) est à jour.

## Flux de travail

1. Fonctionnalité qui touche plusieurs couches ou la structure : demander d'abord un plan au sous-agent `architect`.
2. Implémenter en suivant le skill `add-git-feature` (git.ts → types.ts → main.ts → UI → test → vérification).
3. Vérifier l'interface avec le skill `run-arbor` (ou le sous-agent `ui-tester` pour un parcours complet).
4. Avant la PR, faire relire le diff par le sous-agent `reviewer`.

Plusieurs fonctionnalités indépendantes : skill `parallel-features` (plan de l'architect, un agent `developer` par fonctionnalité dans son worktree, relecture, PR, fusions une par une).
