import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences, normalizePreferences } from './prefs';

describe('normalizePreferences', () => {
  it('rend les défauts pour une valeur absente ou invalide', () => {
    for (const raw of [undefined, null, 42, 'dark', [], {}]) expect(normalizePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
  });

  it('garde le thème sombre par défaut', () => {
    expect(DEFAULT_PREFERENCES.theme).toBe('dark');
    expect(DEFAULT_PREFERENCES.diffFontSize).toBe(12);
    expect(DEFAULT_PREFERENCES.autoRefresh).toBe(true);
    expect(DEFAULT_PREFERENCES.restoreTabs).toBe(true);
  });

  it('conserve les valeurs valides', () => {
    const p = { theme: 'light', diffFontSize: 15, monoFont: 'Fira Code', diffMode: 'split', autoRefresh: false, restoreTabs: false };
    expect(normalizePreferences(p)).toEqual(p);
  });

  it('remplace les valeurs inconnues par les défauts et ignore les champs en trop', () => {
    const p = normalizePreferences({ theme: 'sepia', diffMode: 'side', autoRefresh: 'off', restoreTabs: 1, monoFont: 3, extra: true });
    expect(p).toEqual(DEFAULT_PREFERENCES);
    expect('extra' in p).toBe(false);
  });

  it('borne et arrondit la taille de police', () => {
    expect(normalizePreferences({ diffFontSize: 4 }).diffFontSize).toBe(10);
    expect(normalizePreferences({ diffFontSize: 99 }).diffFontSize).toBe(20);
    expect(normalizePreferences({ diffFontSize: 13.6 }).diffFontSize).toBe(14);
    expect(normalizePreferences({ diffFontSize: Number.NaN }).diffFontSize).toBe(12);
    expect(normalizePreferences({ diffFontSize: '14' }).diffFontSize).toBe(12);
  });

  it('nettoie le nom de police et refuse ce qui sortirait de la déclaration CSS', () => {
    expect(normalizePreferences({ monoFont: '  Fira Code ' }).monoFont).toBe('Fira Code');
    expect(normalizePreferences({ monoFont: 'x; color: red' }).monoFont).toBe('');
    expect(normalizePreferences({ monoFont: 'a'.repeat(300) }).monoFont).toBe('');
  });
});

describe('mergePreferences', () => {
  it('applique un correctif partiel', () => {
    const p = mergePreferences(DEFAULT_PREFERENCES, { diffMode: 'split' });
    expect(p).toEqual({ ...DEFAULT_PREFERENCES, diffMode: 'split' });
  });

  it('normalise le correctif', () => {
    const cur = { ...DEFAULT_PREFERENCES, theme: 'light' as const };
    expect(mergePreferences(cur, { diffFontSize: 50 }).diffFontSize).toBe(20);
    expect(mergePreferences(cur, null)).toEqual(cur);
  });
});
