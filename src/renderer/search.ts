import { useCallback, useSyncExternalStore } from 'react';
import type { Commit, RepoSnapshot } from '../shared/types';
import { api } from './api';

export type SearchField = 'all' | 'message' | 'author' | 'sha' | 'file';

export const SEARCH_FIELDS: { field: SearchField; label: string }[] = [
  { field: 'all', label: 'Tout' },
  { field: 'message', label: 'Message' },
  { field: 'author', label: 'Auteur' },
  { field: 'sha', label: 'SHA' },
  { field: 'file', label: 'Fichier' },
];

/** Dernière recherche par fichier lancée (sur Entrée), avec l'empreinte des refs au moment du lancement. */
export interface FileSearchState {
  text: string;
  refsKey: string;
  req: number;
  status: 'pending' | 'done' | 'error';
  shas: string[];
  truncated: boolean;
  /** `shas` contient un résultat reçu (éventuellement d'une requête précédente sur le même texte). */
  hasResult: boolean;
  error?: string;
}

export interface SearchState {
  open: boolean;
  field: SearchField;
  text: string;
  file: FileSearchState | null;
}

const INITIAL: SearchState = { open: false, field: 'all', text: '', file: null };

// Un état par dépôt, au niveau du module : il survit au démontage du graphe (affichage d'un diff).
const states = new Map<string, SearchState>();
const listeners = new Set<() => void>();
let reqCounter = 0;

export function getSearch(repo: string): SearchState {
  return states.get(repo) ?? INITIAL;
}

export function setSearch(repo: string, patch: Partial<SearchState> | ((s: SearchState) => Partial<SearchState>)): void {
  const cur = getSearch(repo);
  const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
  states.set(repo, next);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSearch(repo: string): [SearchState, (patch: Partial<SearchState>) => void] {
  const state = useSyncExternalStore(subscribe, () => getSearch(repo));
  const update = useCallback((patch: Partial<SearchState>) => setSearch(repo, patch), [repo]);
  return [state, update];
}

/** Empreinte des refs : la recherche par fichier est relancée seulement quand elle change. */
export function refsKey(snap: RepoSnapshot): string {
  const tags = snap.tags.map((t) => `tag:${t.name}=${t.sha}`);
  return [snap.head ?? '', ...snap.branches.map((b) => `${b.name}=${b.sha}`), ...tags].join('\n');
}

/** Lance la recherche par fichier ; une réponse arrivée après une requête plus récente est ignorée. */
export async function runFileSearch(repo: string, text: string, key: string): Promise<void> {
  const req = ++reqCounter;
  setSearch(repo, (s) => {
    // Pendant une relance du même texte, les résultats précédents restent affichés.
    const prev = s.file?.text === text && s.file.hasResult ? s.file : null;
    return { file: { text, refsKey: key, req, status: 'pending', shas: prev?.shas ?? [], truncated: prev?.truncated ?? false, hasResult: !!prev } };
  });
  const apply = (f: Partial<FileSearchState>) =>
    setSearch(repo, (s) => (s.file?.req === req ? { file: { ...s.file, ...f } } : {}));
  try {
    const r = await api.searchCommitsByPath(repo, text);
    apply({ status: 'done', shas: r.shas, truncated: r.truncated, hasResult: true });
  } catch (e) {
    apply({ status: 'error', shas: [], hasResult: false, error: (e as Error).message });
  }
}

/** Minuscules sans accents : « Léa » et « lea » se correspondent. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export interface NormalizedCommit {
  sha: string;
  message: string;
  author: string;
}

export function normalizeCommit(c: Commit): NormalizedCommit {
  return {
    sha: c.sha, // Git écrit toujours les SHA en minuscules
    message: normalize(`${c.subject}\n${c.body}`),
    author: normalize(`${c.author} <${c.email}>`),
  };
}

/** Un préfixe de SHA n'est cherché qu'à partir de 4 caractères hexadécimaux. */
export function isShaQuery(q: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(q);
}

/** `q` doit déjà être normalisé (voir `normalize`). Le champ « file » est traité à part (commande Git). */
export function matchNormalized(n: NormalizedCommit, field: SearchField, q: string): boolean {
  if (!q) return false;
  const sha = isShaQuery(q) && n.sha.startsWith(q);
  switch (field) {
    case 'message':
      return n.message.includes(q);
    case 'author':
      return n.author.includes(q);
    case 'sha':
      return sha;
    case 'all':
      return sha || n.message.includes(q) || n.author.includes(q);
    default:
      return false;
  }
}

export function matchCommit(c: Commit, field: SearchField, text: string): boolean {
  return matchNormalized(normalizeCommit(c), field, normalize(text.trim()));
}
