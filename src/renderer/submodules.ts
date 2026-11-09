import { useEffect, useSyncExternalStore } from 'react';
import type { RepoSnapshot, Submodule, SubmoduleState } from '../shared/types';
import { api } from './api';

// Sous-modules par dépôt, au niveau du module (modèle `search.ts`) : la barre latérale, le panneau des
// modifications et la palette partagent une seule lecture par instantané.

interface Entry {
  /** Instantané pour lequel la liste a été demandée (une seule requête par instantané). */
  snap: RepoSnapshot | null;
  list: Submodule[];
  error: string | null;
}

const EMPTY: Submodule[] = [];
const states = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Dernière liste connue (vide tant qu'elle n'est pas lue, ou sans `.gitmodules`). */
export function getSubmodules(repo: string): Submodule[] {
  return states.get(repo)?.list ?? EMPTY;
}

export function getSubmodulesError(repo: string): string | null {
  return states.get(repo)?.error ?? null;
}

/** Relit la liste pour cet instantané (sans effet si c'est déjà fait) ; aucun appel sans `.gitmodules`. */
export function loadSubmodules(snap: RepoSnapshot): void {
  const repo = snap.path;
  const cur = states.get(repo);
  if (cur?.snap === snap) return;
  if (!snap.features?.submodules) {
    states.set(repo, { snap, list: EMPTY, error: null });
    if (cur?.list.length || cur?.error) emit();
    return;
  }
  // L'ancienne liste reste affichée pendant la lecture.
  states.set(repo, { snap, list: cur?.list ?? EMPTY, error: cur?.error ?? null });
  api
    .submodules(repo)
    .then((list) => {
      if (states.get(repo)?.snap !== snap) return; // réponse dépassée
      states.set(repo, { snap, list, error: null });
      emit();
    })
    .catch((e) => {
      if (states.get(repo)?.snap !== snap) return;
      states.set(repo, { snap, list: EMPTY, error: (e as Error).message });
      emit();
    });
}

/** Sous-modules du dépôt de `snap`, relus à chaque nouvel instantané si `.gitmodules` existe. */
export function useSubmodules(snap: RepoSnapshot): Submodule[] {
  useEffect(() => loadSubmodules(snap), [snap]);
  return useSyncExternalStore(subscribe, () => getSubmodules(snap.path));
}

export function useSubmodulesError(repo: string): string | null {
  return useSyncExternalStore(subscribe, () => getSubmodulesError(repo));
}

export const SUBMODULE_STATE_LABEL: Record<SubmoduleState, string> = {
  ok: 'à jour',
  changed: 'autre commit extrait',
  uninitialized: 'non initialisé',
  conflict: 'en conflit',
  missing: "absent de l'index",
};

/** Infobulle d'un sous-module : état, commit attendu, modifications, URL. */
export function submoduleTitle(s: Submodule): string {
  const lines = [`Sous-module ${s.path}${s.name !== s.path ? ` (${s.name})` : ''}`, `État : ${SUBMODULE_STATE_LABEL[s.state]}`];
  if (s.expected) lines.push(`Commit attendu : ${s.expected.slice(0, 7)}`);
  if (s.dirty) lines.push('Modifications non commitées');
  if (s.untracked) lines.push('Fichiers non suivis');
  if (s.url) lines.push(`URL : ${s.url}`);
  if (s.branch) lines.push(`Branche : ${s.branch}`);
  return lines.join('\n');
}
