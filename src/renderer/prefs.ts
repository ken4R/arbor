import { useSyncExternalStore } from 'react';
import { DEFAULT_PREFERENCES, mergePreferences, normalizePreferences, type Preferences, type PreferencesPatch } from '../shared/prefs';
import { api } from './api';

// Préférences côté rendu : copie locale du fichier tenu par le processus principal (`api.getPreferences`).
// Jamais de localStorage : seules les anciennes clés sont lues une fois, pour la migration.

let current: Preferences = { ...DEFAULT_PREFERENCES };
let loaded = false;
const listeners = new Set<() => void>();
// Écritures en cours : une réponse plus ancienne que la dernière demande n'écrase pas l'état optimiste.
let writeSeq = 0;
// Dernière valeur confirmée par le processus principal (sert à revenir en arrière après un échec).
let confirmed: Preferences = { ...DEFAULT_PREFERENCES };

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

/**
 * Applique le correctif immédiatement (optimiste) puis l'enregistre. En cas d'échec, l'état revient à la valeur
 * enregistrée par le processus principal (relue si possible) et l'erreur est relancée.
 */
export async function updatePreferences(patch: PreferencesPatch): Promise<Preferences> {
  current = mergePreferences(current, patch);
  emit();
  const seq = ++writeSeq;
  try {
    const saved = normalizePreferences(await api.setPreferences(patch));
    confirmed = saved;
    if (seq === writeSeq) {
      current = saved;
      emit();
    }
  } catch (e) {
    try {
      confirmed = normalizePreferences(await api.getPreferences());
    } catch {
      // processus principal injoignable : on garde la dernière valeur confirmée
    }
    if (seq === writeSeq) {
      current = confirmed;
      emit();
    }
    throw e;
  }
  return current;
}

/** Anciennes préférences de la vague 1, en localStorage ; lues une seule fois puis supprimées. */
const LEGACY_KEYS = { autoRefresh: 'arbor.autoRefresh', diffMode: 'arbor.diffMode' } as const;

function readLegacy(): Partial<Preferences> {
  const patch: Partial<Preferences> = {};
  try {
    const auto = localStorage.getItem(LEGACY_KEYS.autoRefresh);
    if (auto === 'on' || auto === 'off') patch.autoRefresh = auto === 'on';
    const mode = localStorage.getItem(LEGACY_KEYS.diffMode);
    if (mode === 'unified' || mode === 'split') patch.diffMode = mode;
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
      confirmed = saved;
      // Une modification faite pendant le chargement l'emporte sur la valeur lue.
      if (seq === writeSeq) current = saved;
    } catch {
      // processus principal injoignable : on garde les défauts
    }
    loaded = true;
    emit();
    const legacy = readLegacy();
    if (Object.keys(legacy).length) {
      try {
        await updatePreferences(legacy);
        // Les anciennes clés ne sont retirées qu'une fois la migration enregistrée.
        localStorage.removeItem(LEGACY_KEYS.autoRefresh);
        localStorage.removeItem(LEGACY_KEYS.diffMode);
      } catch {
        // migration retentée au prochain démarrage
      }
    }
    return current;
  })();
  return loading;
}
