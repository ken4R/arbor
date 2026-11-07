import { describe, expect, it } from 'vitest';
import { FILES_MIN_QUERY, makeEntry, parseQuery, searchEntries, type PaletteKind } from './paletteSearch';

const e = (title: string, kind: PaletteKind = 'command', keywords?: string, boost?: number) => makeEntry(title, kind, title, keywords, boost);
const titles = (r: { entry: { item: string } }[]) => r.map((x) => x.entry.item);

const entries = [
  e('Fetch', 'command', 'Git récupérer'),
  e('Pull'),
  e('Push'),
  e('Fermer le dépôt'),
  e('Checkout feature/api', 'ref'),
  e('Checkout feature/login', 'ref'),
  e('Aller au tag v1.0', 'ref'),
  e('README.md', 'file'),
  e('src/feature.ts', 'file'),
];

describe('parseQuery', () => {
  it('reconnaît les préfixes', () => {
    expect(parseQuery('>fet')).toEqual({ kind: 'command', text: 'fet' });
    expect(parseQuery('@feat')).toEqual({ kind: 'ref', text: 'feat' });
    expect(parseQuery('#read')).toEqual({ kind: 'file', text: 'read' });
    expect(parseQuery('fet')).toEqual({ kind: null, text: 'fet' });
    expect(parseQuery('')).toEqual({ kind: null, text: '' });
  });
});

describe('searchEntries', () => {
  it('requête vide sans préfixe : commandes seulement, dans l’ordre', () => {
    expect(titles(searchEntries(entries, ''))).toEqual(['Fetch', 'Pull', 'Push', 'Fermer le dépôt']);
  });

  it('préfixes : une seule sorte d’entrée', () => {
    expect(titles(searchEntries(entries, '@'))).toEqual(['Checkout feature/api', 'Checkout feature/login', 'Aller au tag v1.0']);
    expect(titles(searchEntries(entries, '#'))).toEqual(['README.md', 'src/feature.ts']);
    expect(titles(searchEntries(entries, '>fe'))).toEqual(['Fetch', 'Fermer le dépôt']);
  });

  it(`sans préfixe, fichiers seulement à partir de ${FILES_MIN_QUERY} caractères`, () => {
    expect(titles(searchEntries(entries, 'fe'))).not.toContain('src/feature.ts');
    expect(titles(searchEntries(entries, 'feat'))).toContain('src/feature.ts');
    expect(titles(searchEntries(entries, 'feat'))).toContain('Checkout feature/api');
  });

  it('trie par score et renvoie les indices du titre', () => {
    const r = searchEntries(entries, 'fet');
    expect(r[0].entry.item).toBe('Fetch');
    expect(r[0].indices).toEqual([0, 1, 2]);
  });

  it('cherche dans les mots-clés en dernier recours, sans surbrillance', () => {
    const r = searchEntries(entries, 'recuperer');
    expect(titles(r)).toEqual(['Fetch']);
    expect(r[0].indices).toEqual([]);
    // Une correspondance sur un titre passe devant une correspondance sur des mots-clés.
    expect(titles(searchEntries([e('Commande', 'command', 'pull'), e('Pull')], 'pull'))).toEqual(['Pull', 'Commande']);
  });

  it('le bonus départage deux scores égaux', () => {
    expect(titles(searchEntries([e('Pull'), e('Push', 'command', undefined, 0.5)], 'pu'))).toEqual(['Push', 'Pull']);
  });

  it('respecte la limite', () => {
    const many = Array.from({ length: 80 }, (_, i) => e(`branche-${i}`, 'ref'));
    expect(searchEntries(many, '@br')).toHaveLength(50);
    expect(searchEntries(many, '@br', 5)).toHaveLength(5);
  });
});
