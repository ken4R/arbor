---
name: add-git-feature
description: Recette pour ajouter une commande ou fonctionnalité Git à Arbor de bout en bout (git.ts, contrat IPC, UI, tests, vérification visuelle).
---

# Ajouter une fonctionnalité Git

Suivre les étapes dans l'ordre ; chacune dépend de la précédente.

1. **`src/main/git.ts`** : ajouter une fonction `export async function maCommande(repo: string, …)`.
   - Appeler `git(repo, [...args])` avec un tableau d'arguments, jamais une chaîne shell.
   - Placer `--` avant les chemins de fichiers pour qu'un nom commençant par `-` ne soit pas pris pour une option.
   - Si la sortie doit être analysée, écrire une fonction pure `parseXxx(out: string)` séparée, avec des séparateurs `\x1f`/`\x1e` ou `-z` plutôt que des espaces.
   - Les messages d'erreur visibles sont en français (`throw new GitError('…', '')`).
2. **`src/shared/types.ts`** : ajouter la signature dans `ArborApi` (et les types de données nécessaires).
3. **`src/main/main.ts`** : référencer la fonction dans l'objet `handlers` (le nom doit être identique à celui d'`ArborApi`).
4. **UI** (`src/renderer/`) :
   - Déclencher l'opération via `ui.run('Libellé…', () => api.maCommande(...), 'Message de succès')`.
   - Entrée utilisateur ou confirmation : `ui.ask({...})`. Toute action destructrice a `danger: true` et un message qui dit ce qui sera perdu.
   - Menus contextuels : ajouter l'entrée dans `actions.ts` (`branchMenu` ou `commitMenu`).
   - Si l'état du dépôt change de nature (nouvelle opération en cours…), l'exposer dans `WorkingStatus` et le bandeau de `WorkingPanel`.
5. **Tests** : tester chaque fonction `parseXxx` dans `src/main/git.test.ts` (cas normal + cas limites : dépôt vide, HEAD détachée, noms avec espaces ou accents).
6. **Vérification** : `npm run typecheck && npm test`, puis skill `run-arbor` avec un scénario qui exerce la fonctionnalité, et contrôle de l'état réel du dépôt avec `git`.
7. **README** : cocher la fonctionnalité dans la liste et la retirer de la feuille de route.
