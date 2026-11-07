import { fuzzyMatch, prepareQuery, prepareText, type PreparedText } from './fuzzy';

// Recherche de la palette de commandes (fonctions pures) : préfixes de la requête, filtrage par sorte d'entrée,
// recherche floue sur le titre puis, à défaut, sur les mots-clés.

/** Sorte d'entrée : commande, référence (branche ou tag), fichier modifié. */
export type PaletteKind = 'command' | 'ref' | 'file';

export interface PaletteEntry<T> {
  item: T;
  kind: PaletteKind;
  title: PreparedText;
  /** Mots-clés (et groupe) cherchés si le titre ne correspond pas. */
  keywords: PreparedText | null;
  /** Bonus ajouté au score (ex. commande lancée récemment) pour départager. */
  boost?: number;
}

export interface PaletteResult<T> {
  entry: PaletteEntry<T>;
  score: number;
  /** Indices des caractères correspondants dans le titre (vide pour une correspondance sur les mots-clés). */
  indices: number[];
}

export const PALETTE_LIMIT = 50;
/** Sans préfixe, les fichiers modifiés n'apparaissent qu'au-delà de cette longueur de requête. */
export const FILES_MIN_QUERY = 3;
/** Une correspondance sur les mots-clés seulement passe derrière une correspondance sur le titre. */
export const KEYWORD_PENALTY = 10;

export function makeEntry<T>(item: T, kind: PaletteKind, title: string, keywords?: string, boost?: number): PaletteEntry<T> {
  return { item, kind, title: prepareText(title), keywords: keywords ? prepareText(keywords) : null, boost };
}

/** `>` commandes, `@` branches et tags, `#` fichiers modifiés ; sans préfixe, `kind` vaut null. */
export function parseQuery(raw: string): { kind: PaletteKind | null; text: string } {
  const c = raw[0];
  if (c === '>') return { kind: 'command', text: raw.slice(1) };
  if (c === '@') return { kind: 'ref', text: raw.slice(1) };
  if (c === '#') return { kind: 'file', text: raw.slice(1) };
  return { kind: null, text: raw };
}

/**
 * Entrées qui correspondent à `raw`, de la meilleure à la moins bonne (ordre d'origine à score égal), au plus `limit`.
 * Sans préfixe : requête vide = commandes seulement ; fichiers à partir de `FILES_MIN_QUERY` caractères.
 */
export function searchEntries<T>(entries: readonly PaletteEntry<T>[], raw: string, limit = PALETTE_LIMIT): PaletteResult<T>[] {
  const { kind, text } = parseQuery(raw);
  const q = prepareQuery(text);
  const out: (PaletteResult<T> & { order: number })[] = [];
  for (let order = 0; order < entries.length; order++) {
    const entry = entries[order];
    if (kind) {
      if (entry.kind !== kind) continue;
    } else if (entry.kind === 'file' ? q.length < FILES_MIN_QUERY : entry.kind === 'ref' && !q) continue;
    let m = fuzzyMatch(q, entry.title);
    if (!m && entry.keywords) {
      const k = fuzzyMatch(q, entry.keywords);
      if (k) m = { score: k.score - KEYWORD_PENALTY, indices: [] };
    }
    if (m) out.push({ entry, score: m.score + (entry.boost ?? 0), indices: m.indices, order });
  }
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.slice(0, limit).map(({ order: _order, ...r }) => r);
}
