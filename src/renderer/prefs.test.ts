import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences, type Preferences } from '../shared/prefs';

// Processus principal simulé : chaque appel renvoie une promesse que le test résout quand il veut.
type Pending = { patch?: Partial<Preferences>; resolve: (v: Preferences) => void; reject: (e: Error) => void };
const calls: { get: Pending[]; set: Pending[] } = { get: [], set: [] };
let stored: Preferences = { ...DEFAULT_PREFERENCES };

vi.mock('./api', () => ({
  api: {
    getPreferences: () => new Promise((resolve, reject) => calls.get.push({ resolve, reject })),
    setPreferences: (patch: Partial<Preferences>) =>
      new Promise((resolve, reject) => calls.set.push({ patch, resolve, reject })),
  },
}));

async function freshModule() {
  vi.resetModules();
  return import('./prefs');
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.get = [];
  calls.set = [];
  stored = { ...DEFAULT_PREFERENCES };
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
});

describe('updatePreferences', () => {
  it('ignore une réponse plus ancienne que la dernière écriture', async () => {
    const m = await freshModule();
    const a = m.updatePreferences({ diffMode: 'split' });
    const b = m.updatePreferences({ autoRefresh: false });
    expect(m.getPreferences()).toMatchObject({ diffMode: 'split', autoRefresh: false });
    // Le main répond à B puis à A : la réponse de A (périmée) ne doit pas effacer B.
    stored = mergePreferences(mergePreferences(stored, { diffMode: 'split' }), { autoRefresh: false });
    calls.set[1].resolve(stored);
    await b;
    calls.set[0].resolve(mergePreferences(DEFAULT_PREFERENCES, { diffMode: 'split' }));
    await a;
    expect(m.getPreferences()).toMatchObject({ diffMode: 'split', autoRefresh: false });
  });

  it('revient à la valeur enregistrée après un échec et relance l’erreur', async () => {
    const m = await freshModule();
    const p = m.updatePreferences({ theme: 'light' });
    expect(m.getPreferences().theme).toBe('light');
    calls.set[0].reject(new Error('disque plein'));
    await flush();
    calls.get[0].resolve({ ...DEFAULT_PREFERENCES, diffFontSize: 15 });
    await expect(p).rejects.toThrow('disque plein');
    expect(m.getPreferences()).toEqual({ ...DEFAULT_PREFERENCES, diffFontSize: 15 });
  });
});

describe('loadPreferences', () => {
  it('une modification faite pendant le chargement l’emporte sur la valeur lue', async () => {
    const m = await freshModule();
    const loading = m.loadPreferences();
    void m.updatePreferences({ diffMode: 'split' }).catch(() => {});
    calls.get[0].resolve({ ...DEFAULT_PREFERENCES, diffMode: 'unified' });
    await loading;
    expect(m.getPreferences().diffMode).toBe('split');
  });

  it('ne retire les anciennes clés qu’après une migration enregistrée', async () => {
    localStorage.setItem('arbor.diffMode', 'split');
    localStorage.setItem('arbor.autoRefresh', 'off');
    let m = await freshModule();
    let loading = m.loadPreferences();
    calls.get[0].resolve(DEFAULT_PREFERENCES);
    await flush();
    calls.set[0].reject(new Error('lecture seule'));
    await flush();
    calls.get[1].resolve(DEFAULT_PREFERENCES);
    await loading;
    expect(localStorage.getItem('arbor.diffMode')).toBe('split');

    // Lancement suivant : l'enregistrement réussit, les clés disparaissent.
    calls.get = [];
    calls.set = [];
    m = await freshModule();
    loading = m.loadPreferences();
    calls.get[0].resolve(DEFAULT_PREFERENCES);
    await flush();
    expect(calls.set[0].patch).toEqual({ diffMode: 'split', autoRefresh: false });
    calls.set[0].resolve({ ...DEFAULT_PREFERENCES, diffMode: 'split', autoRefresh: false });
    await loading;
    expect(localStorage.getItem('arbor.diffMode')).toBeNull();
    expect(localStorage.getItem('arbor.autoRefresh')).toBeNull();
    expect(m.getPreferences()).toMatchObject({ diffMode: 'split', autoRefresh: false });
  });
});
