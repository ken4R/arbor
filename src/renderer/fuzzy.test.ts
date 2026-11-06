import { describe, expect, it } from 'vitest';
import { fuzzyScore, prepareText, rankItems } from './fuzzy';

describe('fuzzyScore', () => {
  it('trouve une sous-séquence et renvoie les indices des caractères', () => {
    const m = fuzzyScore('fet', 'Fetch');
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 1, 2]);
  });

  it('renvoie null sans correspondance', () => {
    expect(fuzzyScore('xyz', 'Fetch')).toBeNull();
    expect(fuzzyScore('hcf', 'Fetch')).toBeNull(); // ordre non respecté
    expect(fuzzyScore('fetchs', 'Fetch')).toBeNull(); // requête plus longue
  });

  it('ignore la casse et les accents, des deux côtés', () => {
    expect(fuzzyScore('depot', 'Ouvrir un dépôt…')?.indices).toEqual([10, 11, 12, 13, 14]);
    expect(fuzzyScore('DÉPÔT', 'ouvrir un depot')).not.toBeNull();
    expect(fuzzyScore('preferences', 'Préférences…')?.indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('ignore les espaces de la requête', () => {
    expect(fuzzyScore('co feat', 'Checkout feature/api')).not.toBeNull();
  });

  it('préfère les débuts de mot aux correspondances au milieu des mots', () => {
    const m = fuzzyScore('fa', 'feature/api');
    expect(m!.indices).toEqual([0, 8]);
    expect(fuzzyScore('nb', 'Nouvelle branche')!.indices).toEqual([0, 9]);
  });

  it('reconnaît les débuts de mot en camelCase', () => {
    expect(prepareText('selectCommit').wordStart[6]).toBe(true);
    expect(fuzzyScore('sc', 'selectCommit')!.indices).toEqual([0, 6]);
  });

  it('classe préfixe > début de mot > consécutif > dispersé', () => {
    const prefix = fuzzyScore('pu', 'Push')!.score;
    const word = fuzzyScore('pu', 'Git push')!.score;
    const inner = fuzzyScore('pu', 'Ouvrir pause')!.score; // « p » début de mot mais pas en tête
    const scattered = fuzzyScore('pu', 'Rapport du jour')!.score;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(scattered);
    expect(inner).toBeGreaterThan(scattered);
  });

  it('à score égal, le texte le plus court passe devant', () => {
    expect(fuzzyScore('main', 'main')!.score).toBeGreaterThan(fuzzyScore('main', 'main-old')!.score);
  });

  it('requête vide : correspondance de score nul', () => {
    expect(fuzzyScore('', 'Fetch')).toEqual({ score: 0, indices: [] });
  });
});

describe('rankItems', () => {
  const items = [{ text: 'Pull' }, { text: 'Push' }, { text: 'Fetch' }, { text: 'Checkout feature/login' }, { text: 'Fermer le dépôt' }];

  it('filtre et trie par score', () => {
    const r = rankItems('fe', items).map((x) => x.item.text);
    expect(r[0]).toBe('Fetch');
    expect(r).toContain('Checkout feature/login');
    expect(r).not.toContain('Push');
  });

  it('requête vide : tout, dans l’ordre, avec le bonus en premier', () => {
    expect(rankItems('', items).map((x) => x.item.text)).toEqual(items.map((x) => x.text));
    const boosted = items.map((x) => (x.text === 'Fetch' ? { ...x, boost: 1 } : x));
    expect(rankItems('', boosted)[0].item.text).toBe('Fetch');
  });

  it('le bonus départage deux scores égaux', () => {
    const r = rankItems('pu', [{ text: 'Pull' }, { text: 'Push', boost: 0.5 }]);
    expect(r.map((x) => x.item.text)).toEqual(['Push', 'Pull']);
  });

  it('respecte la limite et réutilise le texte préparé', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ text: `branche-${i}`, prepared: prepareText(`branche-${i}`) }));
    expect(rankItems('br', many)).toHaveLength(50);
    expect(rankItems('br', many, 5)).toHaveLength(5);
  });
});
