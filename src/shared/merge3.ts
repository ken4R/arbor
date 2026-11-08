// Fusion à trois voies ligne par ligne, sans dépendance, pour l'éditeur de fusion.
// La fusion qui fait foi est celle de Git (`git merge-file -p --diff3`, lancé par le processus principal) :
// `parseMergeOutput` lit sa sortie et `blocksFromMergeOutput` en tire les blocs de l'éditeur. Le diff (Myers O(ND),
// espace linéaire, coût bornable) et `merge3` ne servent qu'à situer les conflits dans chaque version et à étiqueter
// les zones sans conflit (changement de mon côté, du leur, des deux).

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
  return withBudget(Infinity, () => diffCore(a, b))!;
}

/** Comme `diffLines`, mais renvoie null au-delà de `budget` étapes de recherche (coût borné). */
export function diffLinesBounded(a: string[], b: string[], budget: number): LineHunk[] | null {
  return withBudget(budget, () => diffCore(a, b));
}

class BudgetExceeded extends Error {}
let budgetLeft = Infinity;

/** Exécute `fn` avec un budget d'étapes de Myers ; null s'il est dépassé. */
function withBudget<T>(budget: number, fn: () => T): T | null {
  const saved = budgetLeft;
  budgetLeft = budget;
  try {
    return fn();
  } catch (e) {
    if (e instanceof BudgetExceeded) return null;
    throw e;
  } finally {
    budgetLeft = saved;
  }
}

function diffCore(a: string[], b: string[]): LineHunk[] {
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
    budgetLeft -= 2 * d + 2;
    if (budgetLeft < 0) throw new BudgetExceeded();
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
  /** Zone sans conflit où Git a combiné des changements des deux côtés sans qu'on sache les séparer : `lines` = texte de Git. */
  | { kind: 'merged'; base: string[]; mine: string[]; theirs: string[]; lines: string[] }
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

/**
 * Fusion à trois voies maison : suite de blocs qui couvre la base dans l'ordre. Elle ne fait pas foi (l'éditeur
 * part de `git merge-file`, voir `blocksFromMergeOutput`) : elle ne sert qu'à étiqueter les zones sans conflit.
 */
export function merge3(base: string[], mine: string[], theirs: string[]): MergeBlock[] {
  return withBudget(Infinity, () => merge3Core(base, mine, theirs))!;
}

function merge3Core(base: string[], mine: string[], theirs: string[]): MergeBlock[] {
  const all = [
    ...diffCore(base, mine).map((h) => ({ ...h, side: 0 })),
    ...diffCore(base, theirs).map((h) => ({ ...h, side: 1 })),
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
  if (b.kind === 'conflict' || b.kind === 'merged') return b[side];
  if (side === 'base') return b.base;
  if (b.kind === 'both') return b.lines;
  return b.kind === side ? b.lines : b.base;
}

/** Choix appliqué d'office à un bloc sans choix explicite ; null = conflit non résolu (ou texte de Git pour `merged`). */
export function defaultChoice(b: MergeBlock): Choice | null {
  if (b.kind === 'conflict' || b.kind === 'merged') return null;
  if (b.kind === 'theirs') return 'theirs';
  return 'mine'; // same, mine, both
}

/** Lignes du résultat pour un bloc et un choix ; null = conflit non résolu (pas de choix). */
export function resolveBlock(b: MergeBlock, choice: Choice | undefined): string[] | null {
  if (choice === undefined && b.kind === 'merged') return b.lines;
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

/** Saut de ligne final de chaque version. */
export interface FinalNewlines {
  base: boolean;
  mine: boolean;
  theirs: boolean;
}

/** Fusion à trois voies du saut de ligne final : le côté qui l'a changé l'emporte. */
const mergedNewline = (f: FinalNewlines) => (f.mine === f.base ? f.theirs : f.mine);

/** Saut de ligne final quand le texte se termine par ce bloc résolu ainsi. */
function newlineAfter(b: MergeBlock, choice: Choice | undefined, f: FinalNewlines): boolean {
  const c = choice ?? (b.kind === 'mine' ? 'mine' : b.kind === 'theirs' ? 'theirs' : null);
  if (c === 'mine' || c === 'theirs-mine') return f.mine;
  if (c === 'theirs' || c === 'mine-theirs') return f.theirs;
  if (c === 'base') return f.base;
  return mergedNewline(f); // same, both, merged, texte libre
}

/**
 * Texte final : blocs résolus selon `choices` (index du bloc), conflits restants écrits avec des marqueurs.
 * `finalNewline` : booléen imposé, ou saut final de chaque version (celui du côté qui fournit la fin du texte).
 */
export function composeResult(blocks: MergeBlock[], choices: Map<number, Choice>, eol: '\n' | '\r\n', finalNewline: boolean | FinalNewlines): string {
  const out: string[] = [];
  let newline = typeof finalNewline === 'boolean' ? finalNewline : mergedNewline(finalNewline);
  blocks.forEach((b, i) => {
    const lines = resolveBlock(b, choices.get(i));
    if (lines) {
      out.push(...lines);
      if (lines.length && typeof finalNewline !== 'boolean') newline = newlineAfter(b, choices.get(i), finalNewline);
    } else if (b.kind === 'conflict') {
      out.push(MARKERS.mine, ...b.mine, MARKERS.base, ...b.base, MARKERS.sep, ...b.theirs, MARKERS.theirs);
      if (typeof finalNewline !== 'boolean') newline = true; // comme Git après un marqueur
    }
  });
  if (!out.length) return '';
  return out.join(eol) + (newline ? eol : '');
}

// --- Sortie de `git merge-file -p --diff3` ---

/** Morceau de la sortie de Git : texte fusionné sans conflit, ou conflit (style diff3). */
export type MergeChunk = { text: string[] } | { mine: string[]; base: string[]; theirs: string[] };

/** Taille de marqueur sûre : plus longue que toute série de `<`, `|`, `=`, `>` en début de ligne des versions (7 au moins). */
export function markerSize(texts: string[]): number {
  let max = 6;
  for (const t of texts) for (const m of t.matchAll(/^(?:<+|\|+|=+|>+)/gm)) max = Math.max(max, m[0].length);
  return max + 1;
}

/**
 * Analyse la sortie de `git merge-file -p --diff3 --marker-size=<size>` (lignes sans fin de ligne). Avec une taille de
 * marqueur plus longue que toute série du contenu, une ligne de marqueur est sans ambiguïté. null si la sortie est mal formée.
 */
export function parseMergeOutput(lines: string[], size = 7): MergeChunk[] | null {
  const marker = (ch: string) => new RegExp(`^\\${ch}{${size}}(?: |$)`);
  const open = marker('<');
  const baseSep = marker('|');
  const sep = new RegExp(`^={${size}}$`);
  const close = marker('>');
  const chunks: MergeChunk[] = [];
  let text: string[] = [];
  let cur: { mine: string[]; base: string[]; theirs: string[] } | null = null;
  let part: 'mine' | 'base' | 'theirs' = 'mine';
  for (const l of lines) {
    if (!cur) {
      if (open.test(l)) {
        if (text.length) chunks.push({ text });
        text = [];
        cur = { mine: [], base: [], theirs: [] };
        part = 'mine';
      } else if (baseSep.test(l) || sep.test(l) || close.test(l)) return null;
      else text.push(l);
    } else if (part === 'mine' && baseSep.test(l)) part = 'base';
    else if (part !== 'theirs' && sep.test(l)) part = 'theirs';
    else if (part === 'theirs' && close.test(l)) {
      chunks.push(cur);
      cur = null;
    } else if (open.test(l) || baseSep.test(l) || sep.test(l) || close.test(l)) return null;
    else cur[part].push(l);
  }
  if (cur) return null;
  if (text.length) chunks.push({ text });
  return chunks;
}

const isConflictChunk = (c: MergeChunk): c is { mine: string[]; base: string[]; theirs: string[] } => !('text' in c);

/** Coût maximal (étapes de Myers) d'un étiquetage ; au-delà, la zone reste un bloc `merged`. */
const LABEL_BUDGET = 2_000_000;

/**
 * Position de chaque conflit dans une version : on reconstruit la version « résolue de ce côté » (texte de Git +
 * sections de ce côté), on l'aligne sur la vraie version et on vérifie le contenu. Repli : première occurrence en ordre.
 * null si une section est introuvable (sortie incohérente avec les versions).
 */
function locateSections(side: string[], chunks: MergeChunk[], pick: 'mine' | 'base' | 'theirs'): number[] | null {
  const resolved: string[] = [];
  const sections: { at: number; lines: string[] }[] = [];
  for (const c of chunks) {
    if (isConflictChunk(c)) {
      sections.push({ at: resolved.length, lines: c[pick] });
      resolved.push(...c[pick]);
    } else resolved.push(...c.text);
  }
  const hunks = withBudget(LABEL_BUDGET, () => diffCore(side, resolved));
  const fits = (s: number, lines: string[], min: number) => s >= min && s + lines.length <= side.length && sameLines(side.slice(s, s + lines.length), lines);
  const out: number[] = [];
  let min = 0;
  for (const sec of sections) {
    const candidates: number[] = [];
    if (hunks) {
      // Décalage dû aux blocs entièrement avant la section ; un bloc vide côté `resolved` pile à cette position est ambigu.
      let before = 0;
      let ambiguous = 0;
      for (const h of hunks) {
        const delta = h.aEnd - h.aStart - (h.bEnd - h.bStart);
        if (h.bEnd < sec.at || (h.bEnd === sec.at && h.bStart < h.bEnd)) before += delta;
        else if (h.bStart === sec.at && h.bEnd === sec.at) ambiguous += delta;
        else if (h.bStart < sec.at && sec.at < h.bEnd) candidates.push(h.aStart + (sec.at - h.bStart));
      }
      candidates.unshift(sec.at + before, sec.at + before + ambiguous);
    }
    let pos = candidates.find((s) => fits(s, sec.lines, min));
    if (pos === undefined) {
      for (let s = min; s + sec.lines.length <= side.length; s++) {
        if (fits(s, sec.lines, min)) {
          pos = s;
          break;
        }
      }
    }
    if (pos === undefined) return null;
    out.push(pos);
    min = pos + sec.lines.length;
  }
  return out;
}

/**
 * Blocs de l'éditeur à partir de la sortie de Git : les conflits viennent de Git tels quels ; chaque zone sans conflit
 * est étiquetée finement (`mine` / `theirs` / `both` / `same`) par `merge3` quand celui-ci retrouve exactement le texte
 * de Git sans conflit, sinon elle reste un bloc `merged` (texte de Git, versions de chaque côté pour l'affichage).
 * Les blocs redonnent exactement chaque version (`blockSide`) et, sans choix, le texte de Git.
 * null si la sortie est incohérente avec les versions.
 */
export function blocksFromMergeOutput(chunks: MergeChunk[], base: string[], mine: string[], theirs: string[]): MergeBlock[] | null {
  const pos = { base: locateSections(base, chunks, 'base'), mine: locateSections(mine, chunks, 'mine'), theirs: locateSections(theirs, chunks, 'theirs') };
  if (!pos.base || !pos.mine || !pos.theirs) return null;
  const conflicts = chunks.filter(isConflictChunk);
  const blocks: MergeBlock[] = [];
  const cursor = { base: 0, mine: 0, theirs: 0 };
  const versions = { base, mine, theirs };
  const pushText = (text: string[], k: number) => {
    // Zone de chaque version entre le conflit précédent et le conflit k (ou la fin).
    const [b, m, t] = (['base', 'mine', 'theirs'] as const).map((s) => versions[s].slice(cursor[s], k < conflicts.length ? pos[s]![k] : versions[s].length));
    if (!text.length && !b.length && !m.length && !t.length) return;
    if (sameLines(text, b) && sameLines(b, m) && sameLines(b, t)) return void blocks.push({ kind: 'same', lines: text });
    const sub = withBudget(LABEL_BUDGET, () => merge3Core(b, m, t));
    if (sub && sub.every((x) => x.kind !== 'conflict') && sameLines(sub.flatMap((x) => resolveBlock(x, undefined) ?? []), text)) {
      blocks.push(...sub);
    } else blocks.push({ kind: 'merged', base: b, mine: m, theirs: t, lines: text });
  };
  let k = 0;
  let pendingText: string[] = [];
  for (const c of chunks) {
    if (!isConflictChunk(c)) {
      pendingText = c.text;
      continue;
    }
    pushText(pendingText, k);
    pendingText = [];
    blocks.push({ kind: 'conflict', base: c.base, mine: c.mine, theirs: c.theirs });
    for (const s of ['base', 'mine', 'theirs'] as const) cursor[s] = pos[s]![k] + c[s].length;
    k++;
  }
  pushText(pendingText, k);
  return blocks;
}

/** Texte d'un fichier en conflit sans les étiquettes des marqueurs (`<<<<<<< HEAD` → `<<<<<<<`), pour comparer deux sorties. */
export function normalizeConflictText(text: string): string {
  return text.replace(/^(<{7}|\|{7}|>{7})(?: [^\r\n]*)?(?=\r?$)/gm, '$1');
}
