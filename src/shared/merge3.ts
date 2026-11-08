// Fusion à trois voies, ligne par ligne, sans dépendance (utilisée par l'éditeur de fusion).
// Les trois versions sont découpées en lignes sans leur fin de ligne ; les changements de chaque côté sont calculés
// par rapport à la base (Myers O(ND), variante en espace linéaire) puis regroupés : deux changements qui se
// chevauchent ou se touchent forment un conflit, sauf s'ils donnent exactement le même texte (comme xdiff
// en niveau « eager », celui de `git merge-file --diff3`).

/** Découpe un texte en lignes. Fin de ligne majoritaire (CRLF ou LF) ; un fichier mixte est normalisé à la recomposition. */
export function splitLines(text: string): { lines: string[]; eol: '\n' | '\r\n'; finalNewline: boolean } {
  if (text === '') return { lines: [], eol: '\n', finalNewline: false };
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const eol = crlf > 0 && crlf >= lf - crlf ? '\r\n' : '\n';
  const finalNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

export interface LineHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** Remplace chaque ligne par un entier (même texte = même entier) pour des comparaisons rapides. */
function intern(a: string[], b: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const conv = (xs: string[]) => {
    const out = new Int32Array(xs.length);
    xs.forEach((x, i) => {
      let id = ids.get(x);
      if (id === undefined) ids.set(x, (id = ids.size));
      out[i] = id;
    });
    return out;
  };
  return [conv(a), conv(b)];
}

/**
 * Blocs de différences entre `a` et `b` (Myers O(ND), « middle snake » en espace linéaire), triés, sans chevauchement :
 * `a[aStart..aEnd)` est remplacé par `b[bStart..bEnd)`. Deux blocs sont toujours séparés par au moins une ligne commune.
 */
export function diffLines(a: string[], b: string[]): LineHunk[] {
  const [x, y] = intern(a, b);
  const keepA = new Uint8Array(x.length);
  const keepB = new Uint8Array(y.length);
  compare(x, 0, x.length, y, 0, y.length, keepA, keepB);
  const hunks: LineHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && keepA[i] && keepB[j]) {
      i++;
      j++;
      continue;
    }
    const h = { aStart: i, aEnd: i, bStart: j, bEnd: j };
    while (i < x.length && !keepA[i]) i++;
    while (j < y.length && !keepB[j]) j++;
    h.aEnd = i;
    h.bEnd = j;
    hunks.push(h);
  }
  return hunks;
}

/** Marque dans `keepA`/`keepB` les lignes communes de `a[aLo..aHi)` et `b[bLo..bHi)`. */
function compare(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number, keepA: Uint8Array, keepB: Uint8Array) {
  // Préfixe et suffixe communs.
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    keepA[aLo++] = 1;
    keepB[bLo++] = 1;
  }
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
    keepA[--aHi] = 1;
    keepB[--bHi] = 1;
  }
  if (aLo === aHi || bLo === bHi) return; // insertion ou suppression pure
  const split = bisect(a, aLo, aHi, b, bLo, bHi);
  if (!split) return; // aucun point commun : tout diffère
  const [sx, sy] = split;
  compare(a, aLo, sx, b, bLo, sy, keepA, keepB);
  compare(a, sx, aHi, b, sy, bHi, keepA, keepB);
}

/**
 * Point de coupe du chemin d'édition le plus court (rencontre des parcours avant et arrière de Myers),
 * en coordonnées absolues ; null si les deux plages n'ont aucune ligne commune.
 */
function bisect(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number): [number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const size = 2 * maxD + 2;
  const v1 = new Int32Array(size).fill(-1);
  const v2 = new Int32Array(size).fill(-1);
  v1[offset + 1] = 0;
  v2[offset + 1] = 0;
  const delta = n - m;
  const front = (delta & 1) !== 0; // delta impair : la rencontre se détecte pendant le parcours avant
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = offset + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1]) ? v1[k1o + 1] : v1[k1o - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = offset + delta - k1;
        if (k2o >= 0 && k2o < size && v2[k2o] !== -1 && x1 >= n - v2[k2o]) return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = offset + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2o - 1] < v2[k2o + 1]) ? v2[k2o + 1] : v2[k2o - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - 1 - x2] === b[bHi - 1 - y2]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = offset + delta - k2;
        if (k1o >= 0 && k1o < size && v1[k1o] !== -1) {
          const x1 = v1[k1o];
          const y1 = x1 - (k1o - offset);
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}

export type MergeBlock =
  | { kind: 'same'; lines: string[] }
  /** Changement d'un seul côté (`mine` / `theirs`) ou identique des deux côtés (`both`) : `lines` = nouveau texte. */
  | { kind: 'mine' | 'theirs' | 'both'; base: string[]; lines: string[] }
  | { kind: 'conflict'; base: string[]; mine: string[]; theirs: string[] };

const sameLines = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

/** Texte d'un côté pour la plage de base [from, to) : lignes de base hors blocs, remplacées dans les blocs. */
function sideText(base: string[], side: string[], hunks: LineHunk[], from: number, to: number): string[] {
  const out: string[] = [];
  let pos = from;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.aStart), ...side.slice(h.bStart, h.bEnd));
    pos = h.aEnd;
  }
  out.push(...base.slice(pos, to));
  return out;
}

/** Fusion à trois voies : suite de blocs qui couvre la base dans l'ordre. */
export function merge3(base: string[], mine: string[], theirs: string[]): MergeBlock[] {
  const all = [
    ...diffLines(base, mine).map((h) => ({ ...h, side: 0 })),
    ...diffLines(base, theirs).map((h) => ({ ...h, side: 1 })),
  ].sort((p, q) => p.aStart - q.aStart || p.aEnd - q.aEnd || p.side - q.side);

  const blocks: MergeBlock[] = [];
  let pos = 0;
  let i = 0;
  while (i < all.length) {
    // Groupe : blocs qui se chevauchent ou se touchent (une fin égale au début suivant compte), d'un côté ou de l'autre.
    const from = all[i].aStart;
    let to = all[i].aEnd;
    const group = [all[i++]];
    while (i < all.length && all[i].aStart <= to) {
      to = Math.max(to, all[i].aEnd);
      group.push(all[i++]);
    }
    if (from > pos) blocks.push({ kind: 'same', lines: base.slice(pos, from) });
    pos = to;
    const ofMine = group.filter((h) => h.side === 0);
    const ofTheirs = group.filter((h) => h.side === 1);
    const baseLines = base.slice(from, to);
    const m = sideText(base, mine, ofMine, from, to);
    const t = sideText(base, theirs, ofTheirs, from, to);
    if (!ofTheirs.length) blocks.push({ kind: 'mine', base: baseLines, lines: m });
    else if (!ofMine.length) blocks.push({ kind: 'theirs', base: baseLines, lines: t });
    else if (sameLines(m, t)) blocks.push({ kind: 'both', base: baseLines, lines: m });
    else blocks.push({ kind: 'conflict', base: baseLines, mine: m, theirs: t });
  }
  if (pos < base.length) blocks.push({ kind: 'same', lines: base.slice(pos) });
  return blocks;
}

export type Choice = 'mine' | 'theirs' | 'mine-theirs' | 'theirs-mine' | 'base' | { custom: string[] };

/** Lignes d'un bloc vues d'un côté (`base`, `mine`, `theirs`). */
export function blockSide(b: MergeBlock, side: 'base' | 'mine' | 'theirs'): string[] {
  if (b.kind === 'same') return b.lines;
  if (b.kind === 'conflict') return b[side];
  if (side === 'base') return b.base;
  if (b.kind === 'both') return b.lines;
  return b.kind === side ? b.lines : b.base;
}

/** Choix appliqué d'office à un bloc sans choix explicite ; null = conflit non résolu. */
export function defaultChoice(b: MergeBlock): Choice | null {
  if (b.kind === 'conflict') return null;
  if (b.kind === 'theirs') return 'theirs';
  return 'mine'; // same, mine, both
}

/** Lignes du résultat pour un bloc et un choix ; null = conflit non résolu (pas de choix). */
export function resolveBlock(b: MergeBlock, choice: Choice | undefined): string[] | null {
  const c = choice ?? defaultChoice(b);
  if (c === null) return null;
  if (typeof c === 'object') return c.custom;
  if (c === 'mine-theirs') return [...blockSide(b, 'mine'), ...blockSide(b, 'theirs')];
  if (c === 'theirs-mine') return [...blockSide(b, 'theirs'), ...blockSide(b, 'mine')];
  return blockSide(b, c);
}

/** Marqueurs écrits pour un conflit encore non résolu (style diff3). */
export const MARKERS = { mine: '<<<<<<< ma version', base: '||||||| base', sep: '=======', theirs: '>>>>>>> leur version' };

/** Une ligne ressemble-t-elle à un marqueur de conflit (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`) ? */
export const isMarkerLine = (l: string) => /^(<{7}|>{7}|\|{7}|={7})( |$)/.test(l);

/** Texte final : blocs résolus selon `choices` (index du bloc), conflits restants écrits avec des marqueurs. */
export function composeResult(blocks: MergeBlock[], choices: Map<number, Choice>, eol: '\n' | '\r\n', finalNewline: boolean): string {
  const out: string[] = [];
  blocks.forEach((b, i) => {
    const lines = resolveBlock(b, choices.get(i));
    if (lines) out.push(...lines);
    else if (b.kind === 'conflict') out.push(MARKERS.mine, ...b.mine, MARKERS.base, ...b.base, MARKERS.sep, ...b.theirs, MARKERS.theirs);
  });
  if (!out.length) return '';
  return out.join(eol) + (finalNewline ? eol : '');
}
