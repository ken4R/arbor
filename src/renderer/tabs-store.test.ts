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
  type TabState,
} from './tabs';

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
});
