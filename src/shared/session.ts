// Session des onglets (`userData/session.json`), lue et écrite par le processus principal.

export interface SessionData {
  /** Dépôts des onglets, dans l'ordre. */
  repos: string[];
  /** Index de l'onglet actif dans `repos` (0 si la liste est vide). */
  active: number;
  /**
   * Dépôts indisponibles à la dernière restauration (disque externe non monté, partage réseau injoignable) :
   * gardés pour rouvrir leur onglet quand ils redeviennent accessibles. Le plus récent en premier.
   */
  missing: string[];
  /** État d'affichage de chaque onglet, par dépôt (clés limitées à `repos`). */
  views: Record<string, PersistedView>;
}

/** Ancrage du défilement du graphe : SHA de la première ligne visible (`null` = ligne du WIP) et décalage en pixels. */
export interface ScrollAnchor {
  sha: string | null;
  offset: number;
}

export type PersistedSearchField = 'all' | 'message' | 'author' | 'sha' | 'file';

/** État d'affichage d'un onglet enregistré dans la session (le brouillon de commit n'en fait pas partie). */
export interface PersistedView {
  v: 1;
  /** Commit sélectionné, `null` = répertoire de travail. */
  selection: string | null;
  graph: ScrollAnchor | null;
  /** Sections de la barre latérale repliées (ou dépliées) par `id`, seulement quand l'état diffère du défaut. */
  collapsed: Record<string, boolean>;
  /** Filtre de la barre latérale. */
  filter: string;
  /** Recherche dans l'historique (sans les résultats d'une recherche par fichier). */
  search: { open: boolean; field: PersistedSearchField; text: string };
}

/** Nombre maximal de dépôts indisponibles conservés. */
export const MISSING_LIMIT = 10;

/** Longueur maximale du filtre, du texte recherché et d'un identifiant de section enregistrés. */
export const VIEW_TEXT_LIMIT = 200;
/** Nombre maximal de sections repliées enregistrées par onglet. */
export const COLLAPSED_LIMIT = 64;
/** Décalage maximal (pixels) d'un ancrage de défilement à l'intérieur de sa ligne. */
const ANCHOR_OFFSET_MAX = 1000;

const SHA = /^[0-9a-f]{4,64}$/;
const SEARCH_FIELDS: readonly PersistedSearchField[] = ['all', 'message', 'author', 'sha', 'file'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown): string | null => (typeof v === 'string' && SHA.test(v) ? v : null);
const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, VIEW_TEXT_LIMIT) : '');

/** Assainit l'état d'affichage d'un onglet ; `null` s'il est inutilisable (autre version, pas un objet). */
export function normalizeView(raw: unknown): PersistedView | null {
  if (!isObject(raw) || raw.v !== 1) return null;
  let graph: ScrollAnchor | null = null;
  if (isObject(raw.graph) && typeof raw.graph.offset === 'number' && Number.isFinite(raw.graph.offset)) {
    const anchorSha = raw.graph.sha === null ? null : sha(raw.graph.sha);
    // Un SHA invalide ne devient pas un ancrage sur le WIP : pas d'ancrage du tout.
    if (raw.graph.sha === null || anchorSha) graph = { sha: anchorSha, offset: Math.min(ANCHOR_OFFSET_MAX, Math.max(0, Math.round(raw.graph.offset))) };
  }
  const collapsed: Record<string, boolean> = {};
  if (isObject(raw.collapsed)) {
    const entries = Object.entries(raw.collapsed).filter(([k, v]) => typeof v === 'boolean' && k !== '' && k.length <= VIEW_TEXT_LIMIT && k !== '__proto__');
    for (const [k, v] of entries.slice(0, COLLAPSED_LIMIT)) collapsed[k] = v as boolean;
  }
  const s = isObject(raw.search) ? raw.search : {};
  return {
    v: 1,
    selection: sha(raw.selection),
    graph,
    collapsed,
    filter: text(raw.filter),
    search: {
      open: typeof s.open === 'boolean' ? s.open : false,
      field: typeof s.field === 'string' && (SEARCH_FIELDS as readonly string[]).includes(s.field) ? (s.field as PersistedSearchField) : 'all',
      text: text(s.text),
    },
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p !== '') : []);
const unique = (list: string[]) => list.filter((p, i) => list.indexOf(p) === i);

/**
 * Assainit une session lue sur disque ou reçue du rendu : chaînes uniquement, sans doublon ; `allowed` filtre les
 * dépôts des onglets (pas les dépôts indisponibles). `active` désigne un index de la liste d'origine : il suit son
 * dépôt après filtrage, et vaut 0 s'il est hors bornes ou si ce dépôt a été écarté. `views` : seulement pour les
 * dépôts retenus, chaque état assaini par `normalizeView` (champs inconnus retirés, textes et sections bornés).
 */
export function normalizeSession(data: unknown, allowed: (path: string) => boolean = () => true): SessionData {
  const d = (data && typeof data === 'object' ? data : {}) as { repos?: unknown; active?: unknown; missing?: unknown; views?: unknown };
  const raw = Array.isArray(d.repos) ? d.repos : [];
  const repos = unique(strings(raw).filter(allowed));
  const i = typeof d.active === 'number' && Number.isInteger(d.active) && d.active >= 0 && d.active < raw.length ? d.active : -1;
  const activeRepo = i >= 0 ? raw[i] : undefined;
  const active = typeof activeRepo === 'string' ? Math.max(0, repos.indexOf(activeRepo)) : 0;
  const missing = unique(strings(d.missing)).filter((p) => !repos.includes(p)).slice(0, MISSING_LIMIT);
  const views: Record<string, PersistedView> = {};
  if (isObject(d.views)) {
    for (const repo of repos) {
      const v = Object.prototype.hasOwnProperty.call(d.views, repo) ? normalizeView(d.views[repo]) : null;
      if (v) views[repo] = v;
    }
  }
  return { repos, active, missing, views };
}
