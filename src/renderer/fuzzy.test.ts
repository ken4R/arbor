import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyScore, prepareQuery, prepareText } from './fuzzy';

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

describe('fuzzyMatch', () => {
  it('donne le même résultat quels que soient les appels précédents (tampons partagés)', () => {
    const p = prepareText('Checkout origin/feature/api');
    const first = fuzzyMatch(prepareQuery('cofa'), p);
    fuzzyMatch(prepareQuery('une requête beaucoup plus longue'), prepareText('une requête beaucoup plus longue que le texte précédent, pour agrandir les tampons'));
    fuzzyMatch(prepareQuery('x'), prepareText('x'));
    expect(fuzzyMatch(prepareQuery('cofa'), p)).toEqual(first);
    expect(first!.indices).toEqual([0, 9, 16, 24]);
  });

  it('5 000 références en moins de 16 ms par frappe', () => {
    const refs = Array.from({ length: 5000 }, (_, i) => prepareText(`Checkout origin/feature/ticket-${i}`));
    const q = prepareQuery('checkoutoriginfeature');
    const run = () => {
      let hits = 0;
      for (const r of refs) if (fuzzyMatch(q, r)) hits++;
      return hits;
    };
    run(); // préchauffage
    const runs = 5;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) expect(run()).toBe(5000);
    const perRun = (performance.now() - t0) / runs;
    expect(perRun).toBeLessThan(16);
  });
});

describe('fuzzyScore : indices dans le texte d’origine', () => {
  const increasing = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);

  it('« ß » et « İ » : un indice par caractère d’origine, croissants et sans doublon', () => {
    expect(fuzzyScore('strasse', 'Straße')).toBeNull(); // « ß » n'est pas développé en « ss »
    expect(fuzzyScore('straß', 'Straße')!.indices).toEqual([0, 1, 2, 3, 4]);
    // « İ » (I point suscrit) : NFD donne « I » + diacritique, retiré ; un seul indice pour ce caractère.
    const m = fuzzyScore('istanbul', 'İstanbul')!;
    expect(m.indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(increasing(m.indices)).toBe(true);
  });

  it('caractère développé en plusieurs caractères normalisés : indice d’origine dédoublonné', () => {
    // « 한 » se décompose (NFD) en trois jamos : les trois correspondances pointent sur le même caractère.
    const m = fuzzyScore('한글', '한글 문서')!;
    expect(m.indices).toEqual([0, 1]);
    expect(increasing(m.indices)).toBe(true);
  });
});

