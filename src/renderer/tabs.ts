import { useSyncExternalStore } from 'react';
import type { DiffTarget, RepoSnapshot } from '../shared/types';
import type { Selection } from './App';
import type { CommitDraft } from './components/WorkingPanel';
import type { FileViewTarget } from './ui';

// Onglets multi-dépôts : modèle (fonctions pures, testées) et magasin du module.
// Un seul `RepoView` est monté à la fois (l'onglet actif) ; l'état des autres onglets est conservé ici.

export interface Tab {
  id: number;
  /** null = onglet vide (écran d'accueil). */
  repo: string | null;
}

export interface TabsModel {
  tabs: Tab[];
  activeId: number;
}

/** État d'affichage propre à un onglet, relu au remontage de son `RepoView`. */
export interface TabState {
  selection: Selection;
  diffTarget: DiffTarget | null;
  fileView: FileViewTarget | null;
  draft: CommitDraft;
  /** Dernier instantané connu : affiché immédiatement à l'activation, avant la relecture du dépôt. */
  snap: RepoSnapshot | null;
}

/** Nombre d'onglets dont l'instantané reste en mémoire (les moins récents sont libérés). */
export const SNAP_CACHE_LIMIT = 8;

// ---------------------------------------------------------------------------------------------------------------
// Fonctions pures

/** Onglet actif (le premier si `activeId` est inconnu). */
export function activeTab(m: TabsModel): Tab | undefined {
  return m.tabs.find((t) => t.id === m.activeId) ?? m.tabs[0];
}

/**
 * Ouvre un dépôt. S'il est déjà ouvert dans un onglet, cet onglet est activé (pas de doublon).
 * `current` : remplace le dépôt de l'onglet actif ; `new` : nouvel onglet, sauf si l'onglet actif est vide.
 * Un onglet dont le dépôt change reçoit l'identifiant `newId` (son état d'affichage repart de zéro).
 */
export function openInTabs(m: TabsModel, path: string, mode: 'current' | 'new', newId: number): TabsModel {
  const existing = m.tabs.find((t) => t.repo === path);
  if (existing) return { ...m, activeId: existing.id };
  const active = activeTab(m);
  if (!active) return { tabs: [{ id: newId, repo: path }], activeId: newId };
  if (mode === 'current' || active.repo === null) {
    return { tabs: m.tabs.map((t) => (t.id === active.id ? { id: newId, repo: path } : t)), activeId: newId };
  }
  const i = m.tabs.indexOf(active);
  return { tabs: [...m.tabs.slice(0, i + 1), { id: newId, repo: path }, ...m.tabs.slice(i + 1)], activeId: newId };
}

/** Ajoute un onglet vide après l'onglet actif et l'active. */
export function addEmptyTab(m: TabsModel, newId: number): TabsModel {
  const active = activeTab(m);
  const i = active ? m.tabs.indexOf(active) : m.tabs.length - 1;
  return { tabs: [...m.tabs.slice(0, i + 1), { id: newId, repo: null }, ...m.tabs.slice(i + 1)], activeId: newId };
}

/**
 * Ferme un onglet. Fermer l'onglet actif active son voisin de droite (ou de gauche s'il était le dernier).
 * Il reste toujours un onglet : fermer le seul onglet le remplace par un onglet vide `newId`
 * (sans effet s'il est déjà vide).
 */
export function closeTab(m: TabsModel, id: number, newId: number): TabsModel {
  const i = m.tabs.findIndex((t) => t.id === id);
  if (i < 0) return m;
  if (m.tabs.length === 1) {
    return m.tabs[0].repo === null ? m : { tabs: [{ id: newId, repo: null }], activeId: newId };
  }
  const tabs = m.tabs.filter((t) => t.id !== id);
  if (m.activeId !== id) return { ...m, tabs };
  return { tabs, activeId: tabs[Math.min(i, tabs.length - 1)].id };
}

/** Active l'onglet suivant (`delta` = 1) ou précédent (-1), en bouclant. */
export function cycleTab(m: TabsModel, delta: number): TabsModel {
  const n = m.tabs.length;
  if (n < 2) return m;
  const i = Math.max(0, m.tabs.findIndex((t) => t.id === m.activeId));
  return { ...m, activeId: m.tabs[(((i + delta) % n) + n) % n].id };
}

/** Session enregistrée : dépôts des onglets non vides, dans l'ordre, et index de l'onglet actif parmi eux. */
export function toSession(m: TabsModel): { repos: string[]; active: number } {
  const withRepo = m.tabs.filter((t): t is Tab & { repo: string } => t.repo !== null);
  return { repos: withRepo.map((t) => t.repo), active: Math.max(0, withRepo.findIndex((t) => t.id === m.activeId)) };
}

/** Onglets d'une session restaurée, numérotés à partir de `firstId` (un onglet vide si la session est vide). */
export function fromSession(repos: string[], active: number, firstId: number): TabsModel {
  const unique = repos.filter((r, i) => repos.indexOf(r) === i);
  if (!unique.length) return { tabs: [{ id: firstId, repo: null }], activeId: firstId };
  const tabs = unique.map((repo, i) => ({ id: firstId + i, repo }));
  const a = Number.isInteger(active) && active >= 0 && active < tabs.length ? active : 0;
  return { tabs, activeId: tabs[a].id };
}

/** Met `id` en tête de la liste des onglets du plus récent au moins récent. */
export function touchRecency(recency: number[], id: number): number[] {
  return [id, ...recency.filter((x) => x !== id)];
}

/** Onglets (encore ouverts) dont l'instantané en cache doit être libéré : au-delà des `limit` plus récents. */
export function staleTabs(recency: number[], openIds: number[], limit: number = SNAP_CACHE_LIMIT): number[] {
  return recency.filter((id) => openIds.includes(id)).slice(limit);
}

// ---------------------------------------------------------------------------------------------------------------
// Magasin du module

let model: TabsModel = { tabs: [{ id: 1, repo: null }], activeId: 1 };
let nextId = 2;
let recency: number[] = [1];
/** Dépôts des onglets fermés, le plus récent en dernier (« Rouvrir l'onglet fermé »). */
let closed: string[] = [];
/** Libellé de l'opération en cours dans l'onglet actif : changer ou fermer d'onglet est alors bloqué. */
let busy: string | null = null;
const states = new Map<number, TabState>();
const listeners = new Set<() => void>();

const CLOSED_LIMIT = 20;

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function commit(next: TabsModel) {
  if (next === model) return;
  const openIds = next.tabs.map((t) => t.id);
  for (const id of [...states.keys()]) if (!openIds.includes(id)) states.delete(id);
  recency = touchRecency(
    recency.filter((id) => openIds.includes(id)),
    next.activeId,
  );
  for (const id of staleTabs(recency, openIds)) {
    const s = states.get(id);
    if (s?.snap) states.set(id, { ...s, snap: null });
  }
  model = next;
  emit();
}

export function getTabsModel(): TabsModel {
  return model;
}

export function useTabsModel(): TabsModel {
  return useSyncExternalStore(subscribe, getTabsModel);
}

export function getTabsBusy(): string | null {
  return busy;
}

export function useTabsBusy(): string | null {
  return useSyncExternalStore(subscribe, getTabsBusy);
}

/** Signalé par `RepoView` : une opération est en cours (ou terminée avec `null`). */
export function setTabsBusy(label: string | null) {
  if (busy === label) return;
  busy = label;
  emit();
}

/** Ouvre (ou active) un dépôt ; jamais bloqué, car il peut terminer l'opération « Ouverture… » en cours. */
export function openRepoTab(path: string, mode: 'current' | 'new') {
  commit(openInTabs(model, path, mode, nextId++));
}

export function newTab() {
  if (busy) return;
  commit(addEmptyTab(model, nextId++));
}

export function activateTab(id: number) {
  if (busy || !model.tabs.some((t) => t.id === id)) return;
  commit({ ...model, activeId: id });
}

export function closeTabById(id: number = model.activeId) {
  if (busy) return;
  const tab = model.tabs.find((t) => t.id === id);
  if (tab?.repo) closed = [...closed.filter((p) => p !== tab.repo), tab.repo].slice(-CLOSED_LIMIT);
  commit(closeTab(model, id, nextId++));
}

export function cycleTabs(delta: number) {
  if (busy) return;
  commit(cycleTab(model, delta));
}

export function canReopenClosed(): boolean {
  return closed.length > 0;
}

export function reopenClosedTab() {
  if (busy) return;
  const path = closed.pop();
  if (path) commit(openInTabs(model, path, 'new', nextId++));
  else emit();
}

/** Remplace tous les onglets par ceux d'une session restaurée (au démarrage). */
export function restoreTabs(repos: string[], active: number) {
  states.clear();
  const next = fromSession(repos, active, nextId);
  nextId += next.tabs.length;
  recency = [];
  commit(next);
}

export function getTabState(id: number): TabState | undefined {
  return states.get(id);
}

export function saveTabState(id: number, s: TabState) {
  if (model.tabs.some((t) => t.id === id)) states.set(id, s);
}
