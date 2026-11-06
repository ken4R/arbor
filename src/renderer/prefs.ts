import { useSyncExternalStore } from 'react';
import { DEFAULT_PREFERENCES, mergePreferences, normalizePreferences, type Preferences } from '../shared/prefs';
import { api } from './api';

// Préférences côté rendu : copie locale du fichier tenu par le processus principal (`api.getPreferences`).
// Jamais de localStorage : seules les anciennes clés sont lues une fois, pour la migration.

let current: Preferences = { ...DEFAULT_PREFERENCES };
let loaded = false;
const listeners = new Set<() => void>();
// Écritures en cours : une réponse plus ancienne que la dernière demande n'écrase pas l'état optimiste.
let writeSeq = 0;

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getPreferences(): Preferences {
  return current;
}

/** Préférences courantes (défauts tant que le fichier n'est pas lu, puis valeurs enregistrées). */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getPreferences);
}

/** `true` une fois les préférences enregistrées lues (utile pour ne pas agir sur les défauts provisoires). */
export function usePreferencesLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => loaded);
}

/** Applique le correctif immédiatement (optimiste) puis l'enregistre ; en cas d'échec, la valeur reste en mémoire. */
export async function updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  current = mergePreferences(current, patch);
  emit();
  const seq = ++writeSeq;
  try {
    const saved = await api.setPreferences(patch);
    if (seq === writeSeq) {
      current = normalizePreferences(saved);
      emit();
    }
  } catch {
    // préférence non enregistrée : elle reste active pour cette session
  }
  return current;
}

/** Anciennes préférences de la vague 1, en localStorage ; lues une seule fois puis supprimées. */
const LEGACY_KEYS = { autoRefresh: 'arbor.autoRefresh', diffMode: 'arbor.diffMode' } as const;

function takeLegacy(): Partial<Preferences> {
  const patch: Partial<Preferences> = {};
  try {
    const auto = localStorage.getItem(LEGACY_KEYS.autoRefresh);
    if (auto === 'on' || auto === 'off') patch.autoRefresh = auto === 'on';
    const mode = localStorage.getItem(LEGACY_KEYS.diffMode);
    if (mode === 'unified' || mode === 'split') patch.diffMode = mode;
    localStorage.removeItem(LEGACY_KEYS.autoRefresh);
    localStorage.removeItem(LEGACY_KEYS.diffMode);
  } catch {
    // stockage indisponible : rien à migrer
  }
  return patch;
}

let loading: Promise<Preferences> | null = null;

/** Lit les préférences enregistrées (une fois) et migre les anciennes clés localStorage. Appelé au démarrage. */
export function loadPreferences(): Promise<Preferences> {
  loading ??= (async () => {
    const seq = writeSeq;
    try {
      const saved = normalizePreferences(await api.getPreferences());
      // Une modification faite pendant le chargement l'emporte sur la valeur lue.
      if (seq === writeSeq) current = saved;
    } catch {
      // processus principal injoignable : on garde les défauts
    }
    loaded = true;
    emit();
    const legacy = takeLegacy();
    if (Object.keys(legacy).length) await updatePreferences(legacy);
    return current;
  })();
  return loading;
}
