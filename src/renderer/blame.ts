import type { BlameLine } from '../shared/types';

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
