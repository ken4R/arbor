import { beforeEach, describe, expect, it } from 'vitest';
import type { RepoSnapshot } from '../shared/types';
import {
  canReopenClosed,
  closeTabById,
  getTabState,
  getTabsModel,
  newTab,
  openRepoTab,
  reopenClosedTab,
  requestCloseTab,
  resetTabsStore,
  saveTabState,
  setTabsBusy,
  SNAP_CACHE_LIMIT,
  getPendingClose,
  getTabView,
  onViewChange,
  patchTabView,
  restoreTabs,
  toPersistedView,
  type TabState,
} from './tabs';
import { getSearch } from './search';

// Magasin du module : remis à zéro avant chaque test.

const repos = () => getTabsModel().tabs.map((t) => t.repo);
const activeRepo = () => getTabsModel().tabs.find((t) => t.id === getTabsModel().activeId)?.repo;
const activeId = () => getTabsModel().activeId;
const state = (summary = '', snap: RepoSnapshot | null = null): TabState => ({
  selection: { kind: 'commit', sha: 'abc' },
  diffTarget: null,
  fileView: null,
  draft: { summary, description: '', amend: false },
  snap,
  view: { graph: null, collapsed: {}, filter: '' },
});
const fakeSnap = (path: string) => ({ path }) as unknown as RepoSnapshot;

beforeEach(() => resetTabsStore());

describe('magasin des onglets', () => {
  it('refuse d’ouvrir un dépôt pendant une opération, sauf si elle ouvre un dépôt', () => {
    openRepoTab('/a', 'current');
    setTabsBusy('Push…');
    expect(openRepoTab('/b', 'new')).toBe(false);
    expect(repos()).toEqual(['/a']);
    setTabsBusy('Ouverture…', { allowOpen: true });
    expect(openRepoTab('/b', 'current')).toBe(true);
    expect(repos()).toEqual(['/b']);
    setTabsBusy(null);
  });

  it('bloque nouvel onglet et fermeture pendant une opération', () => {
    openRepoTab('/a', 'current');
    setTabsBusy('Pull…');
    newTab();
    closeTabById();
    expect(repos()).toEqual(['/a']);
  });

  it('garde l’onglet remplacé pour « Rouvrir l’onglet fermé », avec son état', () => {
    openRepoTab('/a', 'current');
    saveTabState(activeId(), state('brouillon A', fakeSnap('/a')));
    openRepoTab('/b', 'current');
    expect(repos()).toEqual(['/b']);
    expect(canReopenClosed()).toBe(true);
    reopenClosedTab();
    expect(repos()).toEqual(['/b', '/a']);
    expect(activeRepo()).toBe('/a');
    const s = getTabState(activeId());
    expect(s?.draft.summary).toBe('brouillon A');
    expect(s?.selection).toEqual({ kind: 'commit', sha: 'abc' });
    expect(s?.snap).toBeNull(); // l'instantané n'est pas conservé
    expect(canReopenClosed()).toBe(false);
  });

  it('demande confirmation avant de fermer un onglet dont le brouillon n’est pas vide', () => {
    openRepoTab('/a', 'current');
    const a = activeId();
    saveTabState(a, state('à garder'));
    openRepoTab('/b', 'new');
    requestCloseTab(a);
    // Onglet activé, pas fermé : son RepoView pose la question.
    expect(repos()).toEqual(['/a', '/b']);
    expect(activeId()).toBe(a);
    expect(getPendingClose()).toBe(a);
    closeTabById(a);
    expect(repos()).toEqual(['/b']);
    expect(getPendingClose()).toBeNull();
  });

  it('ferme directement un onglet sans brouillon', () => {
    openRepoTab('/a', 'current');
    openRepoTab('/b', 'new');
    requestCloseTab();
    expect(repos()).toEqual(['/a']);
    expect(getPendingClose()).toBeNull();
  });

  it('libère les instantanés des onglets les moins récents', () => {
    const ids: number[] = [];
    for (let i = 0; i <= SNAP_CACHE_LIMIT + 1; i++) {
      openRepoTab(`/r${i}`, i === 0 ? 'current' : 'new');
      ids.push(activeId());
      saveTabState(activeId(), state('', fakeSnap(`/r${i}`)));
    }
    // Un changement d'onglet applique la limite : les deux plus anciens perdent leur instantané, pas leur état.
    newTab();
    const kept = ids.filter((id) => getTabState(id)?.snap);
    expect(kept).toEqual(ids.slice(-(SNAP_CACHE_LIMIT - 1)));
    expect(getTabState(ids[0])?.selection).toEqual({ kind: 'commit', sha: 'abc' });
  });

  it('garde la disposition (défilement, sections, filtre) à la fermeture et à la réouverture', () => {
    openRepoTab('/a', 'current');
    const a = activeId();
    saveTabState(a, state());
    patchTabView(a, { graph: { sha: 'abcd', offset: 4 }, collapsed: { tags: false } });
    patchTabView(a, { filter: 'feat' });
    // Un enregistrement sans `view` (RepoView) garde la disposition.
    saveTabState(a, { ...state('x'), view: undefined });
    openRepoTab('/b', 'new');
    closeTabById(a);
    reopenClosedTab();
    expect(getTabView(activeId())).toEqual({ graph: { sha: 'abcd', offset: 4 }, collapsed: { tags: false }, filter: 'feat' });
  });

  it('prévient des changements d’affichage hors React, sans toucher aux onglets inconnus', () => {
    openRepoTab('/a', 'current');
    let n = 0;
    const off = onViewChange(() => n++);
    patchTabView(activeId(), { filter: 'x' });
    patchTabView(999, { filter: 'y' });
    expect(n).toBe(1);
    expect(getTabView(999).filter).toBe('');
    off();
    patchTabView(activeId(), { filter: 'z' });
    expect(n).toBe(1);
  });

  it('restaure sélection, disposition et recherche depuis la session', () => {
    const view = {
      v: 1 as const,
      selection: 'abcd123',
      graph: { sha: 'abcd123', offset: 3 },
      collapsed: { local: true },
      filter: 'fix',
      search: { open: true, field: 'message' as const, text: 'journal' },
    };
    restoreTabs(['/s1', '/s2'], 1, { '/s1': view });
    const [t1, t2] = getTabsModel().tabs;
    expect(getTabState(t1.id)?.selection).toEqual({ kind: 'commit', sha: 'abcd123' });
    expect(getTabView(t1.id)).toEqual({ graph: view.graph, collapsed: view.collapsed, filter: 'fix' });
    expect(getSearch('/s1')).toMatchObject({ open: true, field: 'message', text: 'journal', file: null });
    expect(getTabState(t2.id)).toBeUndefined();
    // Aller-retour : la vue enregistrée redonne la même chose.
    expect(toPersistedView(getTabState(t1.id), getSearch('/s1'))).toEqual(view);
    expect(toPersistedView(undefined, getSearch('/inconnu'))).toEqual({
      v: 1,
      selection: null,
      graph: null,
      collapsed: {},
      filter: '',
      search: { open: false, field: 'all', text: '' },
    });
  });
});
