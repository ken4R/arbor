import type { BlameLine, FileRevision } from '../shared/types';

// --- Pagination de l'historique d'un fichier ---

/**
 * Arguments de `fileLog` pour la page suivante : on repart de la dernière version chargée,
 * sous son ancien nom s'il a été renommé, en sautant ce commit (`--skip` compte les commits parcourus).
 */
export function nextPageArgs(last: FileRevision): { path: string; rev: string; skip: number } {
  return { path: last.oldPath ?? last.path, rev: last.sha, skip: 1 };
}

/** Ajoute une page à la liste en écartant les SHA déjà présents. */
export function appendRevisions(prev: FileRevision[], page: FileRevision[]): FileRevision[] {
  const seen = new Set(prev.map((r) => r.sha));
  const out = [...prev];
  for (const r of page) {
    if (seen.has(r.sha)) continue;
    seen.add(r.sha);
    out.push(r);
  }
  return out;
}

/** Suite de lignes consécutives attribuées au même commit. */
export interface BlameGroup {
  sha: string;
  /** Indice de la première ligne du groupe dans la liste complète. */
  start: number;
  lines: BlameLine[];
}

/** Regroupe les lignes consécutives d'un même commit : la gouttière n'est affichée qu'une fois par groupe. */
export function groupBlame(lines: BlameLine[]): BlameGroup[] {
  const groups: BlameGroup[] = [];
  lines.forEach((line, i) => {
    const last = groups[groups.length - 1];
    if (last && last.sha === line.sha) last.lines.push(line);
    else groups.push({ sha: line.sha, start: i, lines: [line] });
  });
  return groups;
}

/** Ligne modifiée dans l'arbre de travail mais pas encore commitée (SHA nul). */
export const isUncommitted = (sha: string) => /^0+$/.test(sha);
