import { describe, expect, it } from 'vitest';
import {
  addEmptyTab,
  canOpenWhileBusy,
  closeTab,
  cycleTab,
  displacedTab,
  fromSession,
  withCollapsed,
  hasDraft,
  openInTabs,
  popClosed,
  pushClosed,
  staleTabs,
  tabTitles,
  toSession,
  touchRecency,
  type ClosedTab,
  type TabsModel,
} from './tabs';

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

  it('retire l’onglet vide actif quand le dépôt est déjà ouvert ailleurs', () => {
    const r = openInTabs(m(['/a', '/b', null], 2), '/a', 'current', 9);
    expect(r.tabs.map((t) => t.repo)).toEqual(['/a', '/b']);
    expect(r.activeId).toBe(1);
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

describe('ouverture depuis un onglet d’origine', () => {
  it('ouvre dans l’onglet d’origine même s’il n’est plus actif', () => {
    const r = openInTabs(m([null, '/a'], 1), '/c', 'current', 9, 1);
    expect(r.tabs).toEqual([
      { id: 9, repo: '/c' },
      { id: 2, repo: '/a' },
    ]);
    expect(r.activeId).toBe(9);
  });

  it('ne fait rien si l’onglet d’origine a été fermé', () => {
    const before = m(['/a', '/b'], 0);
    expect(openInTabs(before, '/c', 'current', 9, 42)).toBe(before);
  });
});

describe('ouverture pendant une opération', () => {
  it('n’est permise que sans opération ou pendant une opération qui ouvre un dépôt', () => {
    expect(canOpenWhileBusy(null, false)).toBe(true);
    expect(canOpenWhileBusy('Clonage…', true)).toBe(true);
    expect(canOpenWhileBusy('Push…', false)).toBe(false);
  });

  it('repère l’onglet non vide dont le dépôt serait remplacé', () => {
    const two = m(['/a', null], 0);
    expect(displacedTab(two, '/c', 'current')).toEqual({ id: 1, repo: '/a' });
    expect(displacedTab(two, '/c', 'new')).toBeNull();
    expect(displacedTab(two, '/c', 'current', 2)).toBeNull(); // onglet vide
    expect(displacedTab(two, '/a', 'current')).toBeNull(); // déjà ouvert : simple activation
  });
});

describe('onglets fermés', () => {
  const entry = (repo: string, summary = ''): ClosedTab => ({
    repo,
    state: { selection: { kind: 'wip' }, diffTarget: null, fileView: null, draft: { summary, description: '', amend: false }, view: { graph: null, collapsed: {}, filter: '' } },
  });

  it('empile sans doublon et dans la limite', () => {
    let c = pushClosed([], entry('/a'));
    c = pushClosed(c, entry('/b'));
    c = pushClosed(c, entry('/a', 'nouveau'));
    expect(c.map((x) => x.repo)).toEqual(['/b', '/a']);
    expect(c[1].state?.draft.summary).toBe('nouveau');
    expect(pushClosed(c, entry('/c'), 2).map((x) => x.repo)).toEqual(['/a', '/c']);
  });

  it('dépile le plus récent avec son brouillon', () => {
    const { entry: e, rest } = popClosed([entry('/a'), entry('/b', 'brouillon B')]);
    expect(e?.repo).toBe('/b');
    expect(e?.state?.draft.summary).toBe('brouillon B');
    expect(rest.map((x) => x.repo)).toEqual(['/a']);
    expect(popClosed([])).toEqual({ entry: null, rest: [] });
  });

  it('détecte un brouillon non vide', () => {
    expect(hasDraft(undefined)).toBe(false);
    expect(hasDraft({ draft: { summary: '  ', description: '', amend: true } })).toBe(false);
    expect(hasDraft({ draft: { summary: '', description: 'texte', amend: false } })).toBe(true);
    expect(hasDraft(entry('/a', 'x').state)).toBe(true);
  });
});

describe('tabTitles', () => {
  it('affiche le nom du dossier, ou « Nouvel onglet »', () => {
    expect(tabTitles(['/home/u/arbor', null, 'C:\\dev\\site\\'])).toEqual(['arbor', 'Nouvel onglet', 'site']);
  });

  it('ajoute les dossiers parents nécessaires pour distinguer les homonymes', () => {
    expect(tabTitles(['/a/projet', '/b/projet', '/c/autre'])).toEqual(['a/projet', 'b/projet', 'autre']);
    expect(tabTitles(['/a/x/projet', '/b/x/projet'])).toEqual(['a/x/projet', 'b/x/projet']);
    expect(tabTitles(['/projet', '/a/projet'])).toEqual(['projet', 'a/projet']);
  });
});

describe('sections repliées', () => {
  it('n’enregistre que les sections qui diffèrent de leur état par défaut', () => {
    let c = withCollapsed({}, 'tags', false, true); // Tags (repliée par défaut) dépliée
    expect(c).toEqual({ tags: false });
    c = withCollapsed(c, 'local', true, false);
    expect(c).toEqual({ tags: false, local: true });
    c = withCollapsed(c, 'tags', true, true); // retour au défaut
    expect(c).toEqual({ local: true });
  });
});
