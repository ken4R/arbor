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
| `src/main/preload.ts` | Expose `window.arbor.call` au rendu (contextIsolation activé). |
| `src/shared/types.ts` | Types partagés et interface `ArborApi`, le contrat entre rendu et processus principal. |
| `src/renderer/` | UI React. `graph.ts` = disposition du graphe, `diff.ts` = analyse des patchs, `actions.ts` = menus contextuels, `ui.ts` = contexte (`run`, `ask`, `openMenu`, `showDiff`). |

Règles :
- Le rendu n'accède jamais au système de fichiers ni à `child_process` : tout passe par `ArborApi`.
- Toute opération Git déclenchée par l'UI passe par `ui.run(label, fn, succès?)`, qui gère l'indicateur, les erreurs et le rafraîchissement.
- Pas de `window.prompt/confirm` (non supportés par Electron) : utiliser `ui.ask`.
- Les opérations destructrices (reset hard, suppression de branche, annulation de modifications) demandent une confirmation.
- Couleurs et espacements : variables CSS de `styles.css` (`--bg`, `--accent`…), pas de valeurs en dur dans les composants.

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
