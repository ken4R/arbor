import { describe, expect, it } from 'vitest';
import { addEmptyTab, closeTab, cycleTab, fromSession, openInTabs, staleTabs, toSession, touchRecency, type TabsModel } from './tabs';

const m = (repos: (string | null)[], activeIndex = 0): TabsModel => {
  const tabs = repos.map((repo, i) => ({ id: i + 1, repo }));
  return { tabs, activeId: tabs[activeIndex].id };
};

describe('openInTabs', () => {
  it('active l’onglet existant au lieu de dupliquer', () => {
    const r = openInTabs(m(['/a', '/b'], 0), '/b', 'new', 9);
    expect(r.tabs.map((t) => t.repo)).toEqual(['/a', '/b']);
    expect(r.activeId).toBe(2);
  });

  it('remplit l’onglet actif vide même en mode nouvel onglet', () => {
    const r = openInTabs(m(['/a', null], 1), '/c', 'new', 9);
    expect(r.tabs).toEqual([
      { id: 1, repo: '/a' },
      { id: 9, repo: '/c' },
    ]);
    expect(r.activeId).toBe(9);
  });

  it('ouvre un nouvel onglet juste après l’onglet actif', () => {
    const r = openInTabs(m(['/a', '/b'], 0), '/c', 'new', 9);
    expect(r.tabs.map((t) => t.repo)).toEqual(['/a', '/c', '/b']);
    expect(r.activeId).toBe(9);
  });

  it('remplace le dépôt de l’onglet actif avec un nouvel identifiant en mode courant', () => {
    const r = openInTabs(m(['/a', '/b'], 1), '/c', 'current', 9);
    expect(r.tabs).toEqual([
      { id: 1, repo: '/a' },
      { id: 9, repo: '/c' },
    ]);
    expect(r.activeId).toBe(9);
  });

  it('crée un onglet si la liste est vide', () => {
    expect(openInTabs({ tabs: [], activeId: 0 }, '/a', 'current', 3)).toEqual({ tabs: [{ id: 3, repo: '/a' }], activeId: 3 });
  });
});

describe('addEmptyTab', () => {
  it('insère un onglet vide après l’actif', () => {
    const r = addEmptyTab(m(['/a', '/b'], 0), 7);
    expect(r.tabs.map((t) => t.repo)).toEqual(['/a', null, '/b']);
    expect(r.activeId).toBe(7);
  });
});

describe('closeTab', () => {
  it('active le voisin de droite quand on ferme l’onglet actif', () => {
    expect(closeTab(m(['/a', '/b', '/c'], 1), 2, 9).activeId).toBe(3);
  });

  it('active le voisin de gauche quand l’onglet actif était le dernier', () => {
    const r = closeTab(m(['/a', '/b', '/c'], 2), 3, 9);
    expect(r.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(r.activeId).toBe(2);
  });

  it('garde l’onglet actif quand on en ferme un autre', () => {
    const r = closeTab(m(['/a', '/b', '/c'], 2), 1, 9);
    expect(r.activeId).toBe(3);
    expect(r.tabs.map((t) => t.repo)).toEqual(['/b', '/c']);
  });

  it('remplace le seul onglet par un onglet vide', () => {
    expect(closeTab(m(['/a']), 1, 9)).toEqual({ tabs: [{ id: 9, repo: null }], activeId: 9 });
  });

  it('ne fait rien sur le seul onglet déjà vide ou un identifiant inconnu', () => {
    const solo = m([null]);
    expect(closeTab(solo, 1, 9)).toBe(solo);
    const two = m(['/a', '/b']);
    expect(closeTab(two, 42, 9)).toBe(two);
  });
});

describe('cycleTab', () => {
  it('passe au suivant et au précédent en bouclant', () => {
    expect(cycleTab(m(['/a', '/b', '/c'], 2), 1).activeId).toBe(1);
    expect(cycleTab(m(['/a', '/b', '/c'], 0), -1).activeId).toBe(3);
    expect(cycleTab(m(['/a', '/b', '/c'], 0), 1).activeId).toBe(2);
  });

  it('ne change rien avec un seul onglet', () => {
    const solo = m(['/a']);
    expect(cycleTab(solo, 1)).toBe(solo);
  });
});

describe('session', () => {
  it('ignore les onglets vides et calcule l’index actif parmi les dépôts', () => {
    expect(toSession(m([null, '/a', '/b'], 2))).toEqual({ repos: ['/a', '/b'], active: 1 });
    expect(toSession(m(['/a', null], 1))).toEqual({ repos: ['/a'], active: 0 });
  });

  it('restaure les onglets, sans doublon, avec un index actif borné', () => {
    expect(fromSession(['/a', '/b', '/a'], 1, 10)).toEqual({
      tabs: [
        { id: 10, repo: '/a' },
        { id: 11, repo: '/b' },
      ],
      activeId: 11,
    });
    expect(fromSession(['/a'], 5, 10).activeId).toBe(10);
    expect(fromSession([], 0, 10)).toEqual({ tabs: [{ id: 10, repo: null }], activeId: 10 });
  });

  it('fait un aller-retour sans perte', () => {
    const s = toSession(m(['/a', '/b', '/c'], 2));
    expect(toSession(fromSession(s.repos, s.active, 1))).toEqual(s);
  });
});

describe('cache des instantanés', () => {
  it('garde les onglets récents en tête', () => {
    expect(touchRecency([1, 2, 3], 3)).toEqual([3, 1, 2]);
    expect(touchRecency([], 4)).toEqual([4]);
  });

  it('libère au-delà de la limite, parmi les onglets encore ouverts', () => {
    const recency = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const open = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(staleTabs(recency, open)).toEqual([2, 1]);
    expect(staleTabs(recency, open.filter((id) => id !== 9))).toEqual([1]);
    expect(staleTabs([3, 2, 1], [1, 2, 3], 2)).toEqual([1]);
  });
});
