import type { DiffLine } from '../shared/diff';

export * from '../shared/diff';

/** Associe lignes supprimées et ajoutées pour l'affichage côte à côte. */
export function toSplit(lines: DiffLine[]): [DiffLine | null, DiffLine | null][] {
  const out: [DiffLine | null, DiffLine | null][] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === 'del' || l.type === 'add') {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
      while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push([dels[k] ?? null, adds[k] ?? null]);
    } else {
      out.push([l, l]);
      i++;
    }
  }
  return out;
}
