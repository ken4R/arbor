import { useEffect, useSyncExternalStore } from 'react';
import type { LfsInfo, RepoSnapshot } from '../shared/types';
import { api } from './api';

// Informations LFS par dépôt (modèle `submodules.ts`) : installation de git-lfs, motifs et fichiers du statut stockés
// dans LFS, partagés par la barre latérale, le panneau des modifications et la palette. Une lecture par instantané,
// seulement si le dépôt utilise LFS (`snap.features.lfs`). La liste des fichiers LFS n'est pas lue ici (`lfsFiles`,
// à l'ouverture de la section).

interface Entry {
  snap: RepoSnapshot | null;
  info: LfsInfo | null;
  /** Chemins de `info.lfsPaths`, pour les badges. */
  paths: ReadonlySet<string>;
  error: string | null;
}

const NO_PATHS: ReadonlySet<string> = new Set();
const states = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Dernières informations lues (null tant qu'elles ne le sont pas, ou sans LFS). */
export function getLfsInfo(repo: string): LfsInfo | null {
  return states.get(repo)?.info ?? null;
}

export function getLfsPaths(repo: string): ReadonlySet<string> {
  return states.get(repo)?.paths ?? NO_PATHS;
}

export function getLfsError(repo: string): string | null {
  return states.get(repo)?.error ?? null;
}

/** Relit les informations pour cet instantané (sans effet si c'est déjà fait) ; aucun appel sans LFS. */
export function loadLfs(snap: RepoSnapshot): void {
  const repo = snap.path;
  const cur = states.get(repo);
  if (cur?.snap === snap) return;
  if (!snap.features?.lfs) {
    states.set(repo, { snap, info: null, paths: NO_PATHS, error: null });
    if (cur?.info || cur?.error) emit();
    return;
  }
  states.set(repo, { snap, info: cur?.info ?? null, paths: cur?.paths ?? NO_PATHS, error: cur?.error ?? null });
  const st = snap.status;
  const paths = [...st.unstaged, ...st.staged].map((f) => f.path);
  api
    .lfsInfo(repo, paths)
    .then((info) => {
      if (states.get(repo)?.snap !== snap) return; // réponse dépassée
      states.set(repo, { snap, info, paths: new Set(info.lfsPaths), error: null });
      emit();
    })
    .catch((e) => {
      if (states.get(repo)?.snap !== snap) return;
      states.set(repo, { snap, info: null, paths: NO_PATHS, error: (e as Error).message });
      emit();
    });
}

/** Informations LFS du dépôt de `snap`, relues à chaque nouvel instantané si le dépôt utilise LFS. */
export function useLfsInfo(snap: RepoSnapshot): LfsInfo | null {
  useEffect(() => loadLfs(snap), [snap]);
  return useSyncExternalStore(subscribe, () => getLfsInfo(snap.path));
}

/** Fichiers du statut stockés dans LFS (d'après l'attribut `filter`). */
export function useLfsPaths(snap: RepoSnapshot): ReadonlySet<string> {
  useEffect(() => loadLfs(snap), [snap]);
  return useSyncExternalStore(subscribe, () => getLfsPaths(snap.path));
}

export function useLfsError(repo: string): string | null {
  return useSyncExternalStore(subscribe, () => getLfsError(repo));
}

/** Texte du bandeau affiché quand le dépôt utilise LFS mais que git-lfs est introuvable. */
export const LFS_MISSING_TEXT =
  "git-lfs n'est pas installé : les fichiers LFS apparaissent comme pointeurs et certains peuvent apparaître modifiés à tort ; commits et checkouts peuvent échouer.";

/** git-lfs absent alors que le dépôt utilise LFS (bandeau d'avertissement). */
export function lfsMissing(snap: RepoSnapshot, info: LfsInfo | null): boolean {
  return !!snap.features?.lfs && !!info && !info.installed;
}

// Génération des fichiers LFS : incrémentée après une action LFS (récupération, suivi) pour que la liste ouverte
// soit relue même si le statut n'a pas changé (un pointeur remplacé par son contenu ne modifie pas le statut).
let filesGeneration = 0;
const generationListeners = new Set<() => void>();

export function bumpLfsFiles(): void {
  filesGeneration++;
  generationListeners.forEach((l) => l());
}

export function useLfsFilesGeneration(): number {
  return useSyncExternalStore(
    (l) => {
      generationListeners.add(l);
      return () => generationListeners.delete(l);
    },
    () => filesGeneration,
  );
}
