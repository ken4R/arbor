// Préférences de l'utilisateur : stockées par le processus principal (`userData/prefs.json`), jamais dans localStorage.

export type ThemePreference = 'system' | 'dark' | 'light';
export type DiffMode = 'unified' | 'split';

/** Largeur des panneaux de la fenêtre (commune à tous les onglets), réglée par les séparateurs. */
export interface LayoutPreferences {
  /** Barre latérale, en pixels (SIDEBAR_WIDTH_MIN..SIDEBAR_WIDTH_MAX). */
  sidebarWidth: number;
  /** Panneau de droite (commit, modifications), en pixels (RIGHT_WIDTH_MIN..RIGHT_WIDTH_MAX). */
  rightWidth: number;
}

export interface Preferences {
  /** Thème de l'interface ; `system` suit le réglage du système. */
  theme: ThemePreference;
  /** Taille du code des diffs et du blame, en pixels (DIFF_FONT_SIZE_MIN..DIFF_FONT_SIZE_MAX). */
  diffFontSize: number;
  /** Police du code ; chaîne vide = police à chasse fixe par défaut (`var(--mono)`). */
  monoFont: string;
  diffMode: DiffMode;
  /** Rafraîchissement automatique quand le dépôt change hors d'Arbor. */
  autoRefresh: boolean;
  /** Rouvrir les onglets de la session précédente au démarrage. */
  restoreTabs: boolean;
  layout: LayoutPreferences;
}

/** Correctif de préférences venu du rendu : `layout` peut ne donner qu'une largeur. */
export type PreferencesPatch = Partial<Omit<Preferences, 'layout'>> & { layout?: Partial<LayoutPreferences> };

/** Largeur minimale de la colonne centrale (graphe, diff), réservée par les séparateurs. */
export const CENTER_MIN_WIDTH = 320;

export const SIDEBAR_WIDTH_MIN = 160;
export const SIDEBAR_WIDTH_MAX = 480;
export const RIGHT_WIDTH_MIN = 260;
export const RIGHT_WIDTH_MAX = 640;

export const DIFF_FONT_SIZE_MIN = 10;
export const DIFF_FONT_SIZE_MAX = 20;
/** Longueur maximale du nom de police accepté. */
export const MONO_FONT_MAX_LENGTH = 200;

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: 'dark',
  diffFontSize: 12,
  monoFont: '',
  diffMode: 'unified',
  autoRefresh: true,
  restoreTabs: true,
  layout: Object.freeze({ sidebarWidth: 240, rightWidth: 340 }),
});

/** Caractères permis dans un nom de police : lettres, chiffres, espace, virgule, guillemets, point, tiret, souligné. */
const MONO_FONT_PATTERN = /^[\p{L}\p{N} ,'"._-]*$/u;

const THEMES: readonly ThemePreference[] = ['system', 'dark', 'light'];
const DIFF_MODES: readonly DiffMode[] = ['unified', 'split'];

/** Entier borné, ou `fallback` si la valeur n'est pas un nombre fini. */
export function clampWidth(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

/** Largeurs des panneaux : chaque champ invalide garde la valeur de `fallback` (un correctif peut n'en donner qu'une). */
function normalizeLayout(raw: unknown, fallback: LayoutPreferences): LayoutPreferences {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return {
    sidebarWidth: clampWidth(r.sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, fallback.sidebarWidth),
    rightWidth: clampWidth(r.rightWidth, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX, fallback.rightWidth),
  };
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Rend un objet de préférences valide à partir de n'importe quelle valeur (fichier corrompu, ancienne version,
 * correctif partiel venu du rendu) : champs inconnus ignorés, valeurs invalides remplacées par les défauts,
 * taille de police arrondie et bornée.
 */
export function normalizePreferences(raw: unknown, fallback: Readonly<Preferences> = DEFAULT_PREFERENCES): Preferences {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const d = fallback;
  const size = typeof r.diffFontSize === 'number' && Number.isFinite(r.diffFontSize) ? Math.round(r.diffFontSize) : d.diffFontSize;
  // Le nom de police finit dans une valeur CSS (à appliquer par `style.setProperty`) : liste blanche stricte.
  const font = typeof r.monoFont === 'string' ? r.monoFont.trim() : d.monoFont;
  return {
    theme: oneOf(r.theme, THEMES, d.theme),
    diffFontSize: Math.min(DIFF_FONT_SIZE_MAX, Math.max(DIFF_FONT_SIZE_MIN, size)),
    monoFont: font.length <= MONO_FONT_MAX_LENGTH && MONO_FONT_PATTERN.test(font) ? font : d.monoFont,
    diffMode: oneOf(r.diffMode, DIFF_MODES, d.diffMode),
    autoRefresh: typeof r.autoRefresh === 'boolean' ? r.autoRefresh : d.autoRefresh,
    restoreTabs: typeof r.restoreTabs === 'boolean' ? r.restoreTabs : d.restoreTabs,
    layout: normalizeLayout(r.layout, d.layout),
  };
}

/** Applique un correctif partiel (non vérifié, venu du rendu) à des préférences valides. */
export function mergePreferences(current: Preferences, patch: unknown): Preferences {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  // Une valeur invalide du correctif garde la valeur courante (et non le défaut) ; `layout` peut être partiel.
  return normalizePreferences({ ...current, ...p }, current);
}
