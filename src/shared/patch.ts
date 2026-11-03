// Construction d'un patch partiel (blocs ou lignes choisis) à partir du diff d'un fichier, pour `git apply`.
import { parseDiff, type Hunk } from './diff';
import type { PatchSelection } from './types';

export class PatchError extends Error {}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Première ligne réellement couverte par un côté du bloc (un côté vide désigne la ligne qui précède). */
const firstLine = (start: number, count: number) => (count === 0 ? start + 1 : start);
const startFor = (first: number, count: number) => (count === 0 ? first - 1 : first);

/**
 * Construit le patch d'un seul fichier limité à la sélection.
 * - `reverse = false` (indexer) : patch appliqué tel quel ; un ajout non choisi disparaît, une suppression non choisie devient du contexte.
 * - `reverse = true` (désindexer, annuler) : patch appliqué avec `--reverse` ; un ajout non choisi devient du contexte, une suppression non choisie disparaît.
 * Les indices de lignes sont ceux de `parseDiff(raw).hunks[i].lines`. `lines` absent = bloc entier.
 */
export function buildPartialPatch(raw: string, sel: PatchSelection, reverse: boolean): string {
  const parsed = parseDiff(raw);
  if (parsed.binary) throw new PatchError('Fichier binaire : indexez le fichier entier.');
  const headerEnd = raw.search(/^@@ /m);
  if (headerEnd < 0 || parsed.hunks.length === 0) throw new PatchError('Aucune modification à appliquer.');

  const chosen = new Map<number, Set<number> | null>();
  for (const s of sel) {
    if (!Number.isInteger(s.hunk) || s.hunk < 0 || s.hunk >= parsed.hunks.length) throw new PatchError('Bloc introuvable : rafraîchissez.');
    if (!s.lines) chosen.set(s.hunk, null);
    else if (chosen.get(s.hunk) !== null) {
      const set = chosen.get(s.hunk) ?? new Set<number>();
      for (const k of s.lines) set.add(k);
      chosen.set(s.hunk, set);
    }
  }
  const isChosen = (h: number, k: number) => {
    if (!chosen.has(h)) return false;
    const set = chosen.get(h);
    return set === null || set!.has(k);
  };

  // Un fichier créé ou supprimé ne peut être appliqué qu'en entier.
  if (parsed.newFile || parsed.deletedFile) {
    const complete = parsed.hunks.every((h, i) => h.lines.every((l, k) => (l.type !== 'add' && l.type !== 'del') || isChosen(i, k)));
    if (!complete) throw new PatchError('Fichier créé ou supprimé : indexez le fichier entier.');
  }

  // L'en-tête est gardé sauf les changements de mode, qui concernent le fichier entier.
  const keepModes = parsed.newFile || parsed.deletedFile;
  const header = raw
    .slice(0, headerEnd)
    .split('\n')
    .filter((l) => l !== '' && (keepModes || !/^(old|new) mode /.test(l)));

  const out: string[] = [...header];
  let delta = 0; // décalage cumulé entre côté conservé et côté modifié
  let changes = 0;
  const rawHunkHeaders = raw.slice(headerEnd).split('\n').filter((l) => HUNK_RE.test(l));

  parsed.hunks.forEach((hunk, h) => {
    if (!chosen.has(h)) return;
    const body = transformHunk(hunk, h, isChosen, reverse);
    if (!body.changed) return;
    changes += body.changed;
    const m = rawHunkHeaders[h].match(HUNK_RE)!;
    const [oldStart, oldCount, newStart, newCount] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    let oldFirst: number;
    let newFirst: number;
    if (!reverse) {
      // Côté ancien (index) intact : sa position ne bouge pas.
      oldFirst = firstLine(oldStart, oldCount);
      newFirst = oldFirst + delta;
    } else {
      // Côté nouveau (état actuel) intact.
      newFirst = firstLine(newStart, newCount);
      oldFirst = newFirst - delta;
    }
    out.push(`@@ -${startFor(oldFirst, body.oldCount)},${body.oldCount} +${startFor(newFirst, body.newCount)},${body.newCount} @@${m[5]}`);
    out.push(...body.lines);
    delta += body.newCount - body.oldCount;
  });

  if (changes === 0) throw new PatchError('Aucune ligne sélectionnée.');
  return out.join('\n') + '\n';
}

function transformHunk(hunk: Hunk, h: number, isChosen: (h: number, k: number) => boolean, reverse: boolean) {
  const lines: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let changed = 0;
  let lastKept = false; // la ligne précédente a-t-elle été gardée (pour « \ No newline… ») ?
  hunk.lines.forEach((l, k) => {
    let kind: ' ' | '+' | '-' | null;
    if (l.type === 'meta') {
      if (lastKept) lines.push(l.text);
      return;
    } else if (l.type === 'ctx') kind = ' ';
    else if (isChosen(h, k)) kind = l.type === 'add' ? '+' : '-';
    else if (l.type === 'add') kind = reverse ? ' ' : null;
    else kind = reverse ? null : ' ';
    lastKept = kind !== null;
    if (kind === null) return;
    if (kind !== ' ') changed++;
    if (kind !== '+') oldCount++;
    if (kind !== '-') newCount++;
    lines.push(kind + l.text);
  });
  checkNoNewline(lines);
  return { lines, oldCount, newCount, changed };
}

/** « \ No newline at end of file » doit suivre la dernière ligne du côté concerné ; sinon la sélection est incohérente. */
function checkNoNewline(lines: string[]) {
  lines.forEach((l, i) => {
    if (!l.startsWith('\\') || i === 0) return;
    const marked = lines[i - 1][0];
    const rest = lines.slice(i + 1).filter((r) => !r.startsWith('\\'));
    const clash = rest.some((r) => r[0] === ' ' || marked === ' ' || r[0] === marked);
    if (clash) throw new PatchError('Sélection incohérente en fin de fichier : indexez le bloc entier.');
  });
}
