import { normalize } from './search';

// Recherche floue de la palette de commandes : la requête doit apparaître comme sous-séquence du texte
// (insensible à la casse et aux accents). Le score favorise les débuts de mot, les caractères consécutifs
// et le préfixe du texte ; à score égal, le texte le plus court l'emporte.

/** Texte préparé pour la recherche (calculé une fois, puis réutilisé à chaque frappe). */
export interface PreparedText {
  text: string;
  /** Texte normalisé (minuscules, sans accents). */
  norm: string;
  /** Pour chaque caractère de `norm`, son indice dans `text`. */
  map: number[];
  /** Pour chaque caractère de `norm`, vrai s'il commence un mot. */
  wordStart: boolean[];
}

export interface FuzzyMatch {
  score: number;
  /** Indices (dans le texte d'origine) des caractères correspondants, croissants. */
  indices: number[];
}

const SEPARATORS = /[\s/\\\-_.:@#>()[\]«»,'"]/;

const SCORE_CHAR = 1;
const BONUS_WORD_START = 8;
const BONUS_PREFIX = 6;
const BONUS_CONSECUTIVE = 5;
const PENALTY_GAP = 1;
/** Pénalité par caractère du texte : à score égal, le texte le plus court l’emporte. */
export const PENALTY_LENGTH = 0.01;

export function prepareText(text: string): PreparedText {
  let norm = '';
  const map: number[] = [];
  const wordStart: boolean[] = [];
  let i = 0;
  let prev = '';
  for (const ch of text) {
    const n = normalize(ch);
    // Début de mot : début du texte, après un séparateur, ou majuscule après une minuscule (camelCase).
    const start = i === 0 || SEPARATORS.test(prev) || (ch !== ch.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase());
    for (let k = 0; k < n.length; k++) {
      norm += n[k];
      map.push(i);
      wordStart.push(start && k === 0);
    }
    prev = ch;
    i += ch.length;
  }
  return { text, norm, map, wordStart };
}

/** Requête prête à comparer : normalisée et sans espaces. */
export function prepareQuery(query: string): string {
  return normalize(query).replace(/\s+/g, '');
}

// Tampons de la programmation dynamique, partagés entre les appels (agrandis au besoin, jamais réalloués à chaque
// élément) : la palette compare des milliers d'entrées à chaque frappe.
let bestBuf = new Float64Array(1024);
let fromBuf = new Int32Array(1024);
let loBuf = new Int32Array(64);
let hiBuf = new Int32Array(64);

function ensureBuffers(m: number, n: number) {
  if (bestBuf.length < m * n) {
    const size = Math.max(m * n, bestBuf.length * 2);
    bestBuf = new Float64Array(size);
    fromBuf = new Int32Array(size);
  }
  if (loBuf.length < m) {
    loBuf = new Int32Array(Math.max(m, loBuf.length * 2));
    hiBuf = new Int32Array(loBuf.length);
  }
}

const NONE = -Infinity;

/** Correspondance d'une requête déjà préparée (`prepareQuery`) avec un texte préparé ; null si aucune. */
export function fuzzyMatch(q: string, p: PreparedText): FuzzyMatch | null {
  const t = p.norm;
  const m = q.length;
  const n = t.length;
  if (m === 0) return { score: 0, indices: [] };
  if (m > n) return null;
  ensureBuffers(m, n);
  const lo = loBuf;
  const hi = hiBuf;
  // Préfiltre par sous-séquence : position la plus tôt (glouton avant) et la plus tard (glouton arrière) de chaque
  // caractère de la requête. Sans correspondance, on s'arrête là ; sinon la programmation dynamique ne parcourt que
  // ces fenêtres.
  for (let i = 0, j = 0; i < m; i++, j++) {
    j = t.indexOf(q[i], j);
    if (j < 0) return null;
    lo[i] = j;
  }
  for (let i = m - 1, j = n - 1; i >= 0; i--, j--) {
    j = t.lastIndexOf(q[i], j);
    hi[i] = j;
  }

  // best[i*n + j] = meilleur score avec q[i] placé en t[j] ; from[i*n + j] = position de q[i-1]. Seules les cases
  // de la fenêtre [lo[i], hi[i]] de chaque ligne sont écrites et lues.
  const best = bestBuf;
  const from = fromBuf;
  const ws = p.wordStart;
  for (let i = 0; i < m; i++) {
    const row = i * n;
    const prev = row - n;
    const c = q[i];
    const pLo = i > 0 ? lo[i - 1] : 0;
    const pHi = i > 0 ? hi[i - 1] : -1;
    // Meilleur prédécesseur non consécutif (indice k <= j - 2) vu jusqu'ici.
    let runBest = NONE;
    let runIdx = -1;
    let k = pLo;
    for (let j = lo[i]; j <= hi[i]; j++) {
      best[row + j] = NONE;
      if (i > 0) {
        for (; k <= j - 2 && k <= pHi; k++) {
          const v = best[prev + k];
          if (v > runBest) {
            runBest = v;
            runIdx = k;
          }
        }
      }
      if (t[j] !== c) continue;
      let gain = SCORE_CHAR;
      if (ws[j]) gain += BONUS_WORD_START;
      if (i === 0) {
        if (j === 0) gain += BONUS_PREFIX;
        best[row + j] = gain;
        continue;
      }
      const consecutive = j - 1 >= pLo && j - 1 <= pHi ? best[prev + j - 1] : NONE;
      const viaConsecutive = consecutive === NONE ? NONE : consecutive + gain + BONUS_CONSECUTIVE;
      const viaGap = runBest === NONE ? NONE : runBest + gain - PENALTY_GAP;
      if (viaConsecutive !== NONE && viaConsecutive >= viaGap) {
        best[row + j] = viaConsecutive;
        from[row + j] = j - 1;
      } else if (viaGap !== NONE) {
        best[row + j] = viaGap;
        from[row + j] = runIdx;
      }
    }
  }

  let end = -1;
  let score = NONE;
  const lastRow = (m - 1) * n;
  for (let j = lo[m - 1]; j <= hi[m - 1]; j++) {
    if (best[lastRow + j] > score) {
      score = best[lastRow + j];
      end = j;
    }
  }
  if (end < 0) return null;
  const normIdx: number[] = new Array(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    normIdx[i] = j;
    j = from[i * n + j];
  }
  // Plusieurs caractères normalisés peuvent venir du même caractère d'origine : indices dédoublonnés.
  const indices: number[] = [];
  for (const j of normIdx) {
    const o = p.map[j];
    if (indices[indices.length - 1] !== o) indices.push(o);
  }
  return { score: score - p.text.length * PENALTY_LENGTH, indices };
}


/** Score de `query` dans `text` (sous-séquence, insensible à la casse et aux accents) ; null si aucune correspondance. */
export function fuzzyScore(query: string, text: string): FuzzyMatch | null {
  return fuzzyMatch(prepareQuery(query), prepareText(text));
}
