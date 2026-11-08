// Fonctions pures sur les remotes, utilisées par le rendu (barre latérale, menus).

/**
 * Remote auquel appartient une branche distante (`<remote>/<branche>`) : le plus long nom de remote qui préfixe
 * la branche, pour que `a/b/x` revienne au remote `a/b` et non à `a`. null si aucun ne correspond.
 */
export function remoteOf(remotes: readonly { name: string }[], branch: string): string | null {
  let best: string | null = null;
  for (const r of remotes) if (branch.startsWith(r.name + '/') && (best === null || r.name.length > best.length)) best = r.name;
  return best;
}
