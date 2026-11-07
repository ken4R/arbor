import { describe, expect, it } from 'vitest';
import { MISSING_LIMIT, normalizeSession } from './session';

describe('normalizeSession', () => {
  it('donne une session vide pour une entrée invalide', () => {
    for (const d of [undefined, null, 42, 'x', [], { repos: 'a' }]) {
      expect(normalizeSession(d)).toEqual({ repos: [], active: 0, missing: [] });
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
