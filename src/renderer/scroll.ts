import type { ScrollAnchor } from '../shared/session';

// Ancrage du défilement du graphe par SHA (et non en pixels) : la position survit à l'arrivée de nouveaux commits,
// au démontage du graphe (affichage d'un diff), au changement d'onglet et au redémarrage.
// Ligne 0 = répertoire de travail (WIP), ligne i ≥ 1 = `commits[i - 1]`.

/** Ancrage de la première ligne visible pour un `scrollTop` donné. */
export function anchorFor(commits: readonly { sha: string }[], scrollTop: number, rowH: number): ScrollAnchor {
  const top = Math.max(0, scrollTop);
  const index = Math.min(Math.floor(top / rowH), commits.length);
  const offset = Math.round(top - index * rowH);
  return { sha: index === 0 ? null : commits[index - 1].sha, offset: Math.max(0, offset) };
}

/** `scrollTop` qui remet la ligne ancrée en haut ; 0 si son commit a disparu (reset, rebase…). */
export function scrollTopFor(commits: readonly { sha: string }[], anchor: ScrollAnchor | null, rowH: number): number {
  if (!anchor) return 0;
  const offset = Math.min(Math.max(0, anchor.offset), rowH - 1);
  if (anchor.sha === null) return offset;
  const i = commits.findIndex((c) => c.sha === anchor.sha);
  return i < 0 ? 0 : (i + 1) * rowH + offset;
}

/**
 * Nouveau `scrollTop` quand la liste des commits change sous la vue (commit, fetch, rebase) : la première ligne
 * visible reste en haut. Si son commit a disparu, la position en pixels est gardée.
 */
export function reanchor(prev: readonly { sha: string }[], next: readonly { sha: string }[], scrollTop: number, rowH: number): number {
  const anchor = anchorFor(prev, scrollTop, rowH);
  if (anchor.sha !== null && !next.some((c) => c.sha === anchor.sha)) return scrollTop;
  return scrollTopFor(next, anchor, rowH);
}
