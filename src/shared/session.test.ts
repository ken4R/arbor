import { describe, expect, it } from 'vitest';
import { COLLAPSED_LIMIT, MISSING_LIMIT, VIEW_TEXT_LIMIT, normalizeSession, normalizeView } from './session';

describe('normalizeSession', () => {
  it('donne une session vide pour une entrée invalide', () => {
    for (const d of [undefined, null, 42, 'x', [], { repos: 'a' }]) {
      expect(normalizeSession(d)).toEqual({ repos: [], active: 0, missing: [], views: {} });
    }
  });

  it('ne garde que les chaînes non vides, sans doublon', () => {
    const s = normalizeSession({ repos: ['/a', 3, '/b', '/a', null, '', '/c'], active: 2 });
    expect(s.repos).toEqual(['/a', '/b', '/c']);
    expect(s.active).toBe(1);
  });

  it('ramène un index actif invalide à 0', () => {
    for (const active of [-1, 3, 1.5, '1', NaN, undefined]) {
      expect(normalizeSession({ repos: ['/a', '/b', '/c'], active }).active).toBe(0);
    }
    expect(normalizeSession({ repos: ['/a', '/b', '/c'], active: 2 }).active).toBe(2);
  });

  it('filtre les dépôts autorisés et suit le dépôt actif', () => {
    const s = normalizeSession({ repos: ['/x', '/a', '/y', '/b'], active: 3 }, (p) => !p.startsWith('/x') && p !== '/y');
    expect(s.repos).toEqual(['/a', '/b']);
    expect(s.active).toBe(1);
    // Dépôt actif écarté : premier onglet.
    expect(normalizeSession({ repos: ['/a', '/x'], active: 1 }, (p) => p !== '/x').active).toBe(0);
  });

  it('garde les dépôts indisponibles, sans doublon ni dépôt déjà ouvert, en nombre limité', () => {
    const many = Array.from({ length: MISSING_LIMIT + 5 }, (_, i) => `/m${i}`);
    const s = normalizeSession({ repos: ['/a'], active: 0, missing: ['/a', '/m0', 7, '/m0', ...many] });
    expect(s.missing[0]).toBe('/m0');
    expect(s.missing).not.toContain('/a');
    expect(new Set(s.missing).size).toBe(s.missing.length);
    expect(s.missing).toHaveLength(MISSING_LIMIT);
  });

  it('n’applique pas le filtre aux dépôts indisponibles', () => {
    expect(normalizeSession({ repos: [], missing: ['/m'] }, () => false).missing).toEqual(['/m']);
  });
});

describe('normalizeSession : états d’affichage', () => {
  const view = {
    v: 1,
    selection: 'abc1234',
    graph: { sha: 'def5678', offset: 12 },
    collapsed: { tags: false, 'remote:origin': true },
    filter: 'feat',
    search: { open: true, field: 'author', text: 'Léa' },
  };

  it('garde un état valide, seulement pour les dépôts retenus', () => {
    const s = normalizeSession({ repos: ['/a', '/x'], active: 0, views: { '/a': view, '/x': view, '/autre': view } }, (p) => p !== '/x');
    expect(s.views).toEqual({ '/a': view });
  });

  it('ignore des vues invalides ou d’une autre version', () => {
    expect(normalizeSession({ repos: ['/a'], views: [view] }).views).toEqual({});
    expect(normalizeSession({ repos: ['/a'], views: { '/a': { ...view, v: 2 } } }).views).toEqual({});
    expect(normalizeSession({ repos: ['/a'], views: { '/a': 'x' } }).views).toEqual({});
    // Clé héritée du prototype : jamais lue.
    expect(normalizeSession({ repos: ['toString'], views: {} }).views).toEqual({});
  });

  it('retire les champs inconnus et remplace les valeurs invalides', () => {
    const v = normalizeView({ ...view, draft: 'secret', selection: 'ZZZ', search: { open: 'oui', field: 'tout', text: 3, extra: 1 } });
    expect(v).toEqual({ ...view, selection: null, search: { open: false, field: 'all', text: '' } });
    expect(v && 'draft' in v).toBe(false);
  });

  it('valide l’ancrage du défilement', () => {
    expect(normalizeView({ ...view, graph: { sha: null, offset: 7.6 } })?.graph).toEqual({ sha: null, offset: 8 });
    expect(normalizeView({ ...view, graph: { sha: 'pas-un-sha', offset: 0 } })?.graph).toBeNull();
    expect(normalizeView({ ...view, graph: { sha: 'abcd', offset: Number.NaN } })?.graph).toBeNull();
    expect(normalizeView({ ...view, graph: { sha: 'abcd', offset: -5 } })?.graph).toEqual({ sha: 'abcd', offset: 0 });
    expect(normalizeView({ ...view, graph: { sha: 'abcd', offset: 1e9 } })?.graph?.offset).toBe(1000);
    expect(normalizeView({ ...view, graph: { sha: 'a'.repeat(65), offset: 0 } })?.graph).toBeNull();
  });

  it('borne les textes et le nombre de sections', () => {
    const long = 'x'.repeat(VIEW_TEXT_LIMIT + 50);
    const collapsed = Object.fromEntries(Array.from({ length: COLLAPSED_LIMIT + 10 }, (_, i) => [`s${i}`, true]));
    const v = normalizeView({ ...view, filter: long, search: { ...view.search, text: long }, collapsed: { ...collapsed, bad: 'oui', [long]: true } });
    expect(v?.filter).toHaveLength(VIEW_TEXT_LIMIT);
    expect(v?.search.text).toHaveLength(VIEW_TEXT_LIMIT);
    expect(Object.keys(v!.collapsed)).toHaveLength(COLLAPSED_LIMIT);
    expect(v!.collapsed.bad).toBeUndefined();
  });
});
