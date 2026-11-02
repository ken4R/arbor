import { describe, expect, it } from 'vitest';
import { parseShaList, pathContainsSpec } from './git';

describe('pathContainsSpec', () => {
  it('entoure le texte de jokers, insensible à la casse', () => {
    expect(pathContainsSpec('login')).toBe(':(icase)*login*');
  });

  it('échappe les caractères de motif', () => {
    expect(pathContainsSpec('a*b?[c]\\d')).toBe(':(icase)*a\\*b\\?\\[c\\]\\\\d*');
  });

  it('garde espaces et accents tels quels', () => {
    expect(pathContainsSpec('mon écran.js')).toBe(':(icase)*mon écran.js*');
  });
});

describe('parseShaList', () => {
  it('découpe une sortie -z', () => {
    expect(parseShaList('aaaa\0bbbb\0')).toEqual(['aaaa', 'bbbb']);
  });

  it('renvoie une liste vide pour une sortie vide', () => {
    expect(parseShaList('')).toEqual([]);
    expect(parseShaList('\n')).toEqual([]);
  });
});
