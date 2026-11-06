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
const PENALTY_LENGTH = 0.01;

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

/** Correspondance d'une requête déjà préparée (`prepareQuery`) avec un texte préparé ; null si aucune. */
export function fuzzyMatch(q: string, p: PreparedText): FuzzyMatch | null {
  const t = p.norm;
  const m = q.length;
  const n = t.length;
  if (m === 0) return { score: 0, indices: [] };
  if (m > n) return null;
  // Vérification rapide de la sous-séquence avant le calcul complet.
  for (let i = 0, j = 0; i < m; i++, j++) {
    j = t.indexOf(q[i], j);
    if (j < 0) return null;
  }

  // Programmation dynamique : best[i][j] = meilleur score avec q[i] placé en t[j] ; from[i][j] = position de q[i-1].
  const NONE = -Infinity;
  const best: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(NONE);
    const par = new Int32Array(n).fill(-1);
    // Meilleur prédécesseur non consécutif vu jusqu'ici (indice k < j - 1).
    let runBest = NONE;
    let runIdx = -1;
    for (let j = i; j < n; j++) {
      if (i > 0 && j >= 2) {
        const k = j - 2;
        if (best[i - 1][k] > runBest) {
          runBest = best[i - 1][k];
          runIdx = k;
        }
      }
      if (t[j] !== q[i]) continue;
      let gain = SCORE_CHAR;
      if (p.wordStart[j]) gain += BONUS_WORD_START;
      if (i === 0) {
        if (j === 0) gain += BONUS_PREFIX;
        row[j] = gain;
        continue;
      }
      const prevRow = best[i - 1];
      const consecutive = prevRow[j - 1];
      const viaConsecutive = consecutive === NONE ? NONE : consecutive + gain + BONUS_CONSECUTIVE;
      const viaGap = runBest === NONE ? NONE : runBest + gain - PENALTY_GAP;
      if (viaConsecutive >= viaGap && viaConsecutive !== NONE) {
        row[j] = viaConsecutive;
        par[j] = j - 1;
      } else if (viaGap !== NONE) {
        row[j] = viaGap;
        par[j] = runIdx;
      }
    }
    best.push(row);
    from.push(par);
  }

  let end = -1;
  let score = NONE;
  const last = best[m - 1];
  for (let j = 0; j < n; j++) {
    if (last[j] > score) {
      score = last[j];
      end = j;
    }
  }
  if (end < 0) return null;
  const normIdx: number[] = new Array(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    normIdx[i] = j;
    j = from[i][j];
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

export interface RankInput {
  text: string;
  /** Texte déjà préparé (mémorisé par l'appelant) ; recalculé sinon. */
  prepared?: PreparedText;
  /** Bonus ajouté au score (ex. commandes récemment utilisées) pour départager. */
  boost?: number;
}

export interface Ranked<T> extends FuzzyMatch {
  item: T;
}

/**
 * Classe les éléments qui correspondent à `query`, du meilleur au moins bon, au plus `limit`.
 * Requête vide : tous les éléments, triés par `boost` puis dans l'ordre d'origine.
 */
export function rankItems<T extends RankInput>(query: string, items: readonly T[], limit = 50): Ranked<T>[] {
  const q = prepareQuery(query);
  const out: (Ranked<T> & { order: number })[] = [];
  items.forEach((item, order) => {
    const match = fuzzyMatch(q, item.prepared ?? prepareText(item.text));
    if (match) out.push({ item, score: match.score + (item.boost ?? 0), indices: match.indices, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.slice(0, limit).map(({ order: _order, ...r }) => r);
}
