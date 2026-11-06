import { useEffect, useLayoutEffect } from 'react';
import type { Preferences, ThemePreference } from '../shared/prefs';
import { usePreferences, usePreferencesLoaded } from './prefs';

// Application des préférences d'affichage au document : thème (`data-theme` sur <html>), taille et police du code.
// Importé depuis `main.tsx` : le thème initial est posé dès l'import, puis `ThemeSync` (monté hors de l'application)
// suit les préférences.

export type ResolvedTheme = 'dark' | 'light';

/** Thème effectif : la préférence explicite, ou celui du système pour `system`. */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === 'dark' || pref === 'light') return pref;
  return systemDark ? 'dark' : 'light';
}

/**
 * Valeur de `--mono` pour une police choisie par l'utilisateur, ou `null` pour garder la police par défaut.
 * Un nom simple est mis entre guillemets ; une liste déjà écrite (virgule ou guillemets) est reprise telle quelle.
 * Une police générique de repli termine toujours la liste.
 */
export function monoFontStack(font: string): string | null {
  const f = font.trim();
  if (!f) return null;
  const list = /[,'"]/.test(f) ? f : `"${f}"`;
  return /(^|,)\s*monospace\s*$/i.test(list) ? list : `${list}, monospace`;
}

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const systemDark = () => (media ? media.matches : true);

function applyTheme(pref: ThemePreference) {
  document.documentElement.dataset.theme = resolveTheme(pref, systemDark());
}

function applyCode(p: Preferences) {
  const style = document.documentElement.style;
  style.setProperty('--diff-font-size', `${p.diffFontSize}px`);
  const mono = monoFontStack(p.monoFont);
  if (mono) style.setProperty('--mono', mono);
  else style.removeProperty('--mono');
}

// Thème initial, avant la lecture des préférences : le processus principal règle `nativeTheme.themeSource` sur la
// préférence enregistrée, donc `prefers-color-scheme` donne déjà le bon thème (pas de flash sombre au démarrage).
if (typeof document !== 'undefined') applyTheme('system');

/** Applique les préférences d'affichage au document ; ne rend rien. */
export function ThemeSync(): null {
  const prefs = usePreferences();
  const loaded = usePreferencesLoaded();
  // Tant que le fichier n'est pas lu, les préférences sont les défauts : on garde le thème du système.
  const theme: ThemePreference = loaded ? prefs.theme : 'system';
  useLayoutEffect(() => applyTheme(theme), [theme]);
  useLayoutEffect(() => applyCode(prefs), [prefs]);
  useEffect(() => {
    if (!media) return;
    const onChange = () => applyTheme(theme);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);
  return null;
}
