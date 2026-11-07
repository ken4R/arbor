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
}

/** Nombre maximal de dépôts indisponibles conservés. */
export const MISSING_LIMIT = 10;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p !== '') : []);
const unique = (list: string[]) => list.filter((p, i) => list.indexOf(p) === i);

/**
 * Assainit une session lue sur disque ou reçue du rendu : chaînes uniquement, sans doublon ; `allowed` filtre les
 * dépôts des onglets (pas les dépôts indisponibles). `active` désigne un index de la liste d'origine : il suit son
 * dépôt après filtrage, et vaut 0 s'il est hors bornes ou si ce dépôt a été écarté.
 */
export function normalizeSession(data: unknown, allowed: (path: string) => boolean = () => true): SessionData {
  const d = (data && typeof data === 'object' ? data : {}) as { repos?: unknown; active?: unknown; missing?: unknown };
  const raw = Array.isArray(d.repos) ? d.repos : [];
  const repos = unique(strings(raw).filter(allowed));
  const i = typeof d.active === 'number' && Number.isInteger(d.active) && d.active >= 0 && d.active < raw.length ? d.active : -1;
  const activeRepo = i >= 0 ? raw[i] : undefined;
  const active = typeof activeRepo === 'string' ? Math.max(0, repos.indexOf(activeRepo)) : 0;
  const missing = unique(strings(d.missing)).filter((p) => !repos.includes(p)).slice(0, MISSING_LIMIT);
  return { repos, active, missing };
}
