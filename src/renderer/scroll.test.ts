import { describe, expect, it } from 'vitest';
import { anchorFor, scrollTopFor } from './scroll';

const commits = ['a1', 'b2', 'c3', 'd4'].map((sha) => ({ sha }));
const H = 30;

describe('ancrage du défilement', () => {
  it('ancre sur le WIP en haut de la liste', () => {
    expect(anchorFor(commits, 0, H)).toEqual({ sha: null, offset: 0 });
    expect(anchorFor(commits, 12, H)).toEqual({ sha: null, offset: 12 });
    expect(anchorFor(commits, -40, H)).toEqual({ sha: null, offset: 0 });
  });

  it('ancre sur le commit de la première ligne visible', () => {
    expect(anchorFor(commits, 30, H)).toEqual({ sha: 'a1', offset: 0 });
    expect(anchorFor(commits, 75, H)).toEqual({ sha: 'b2', offset: 15 });
    // Au-delà de la dernière ligne : dernier commit.
    expect(anchorFor(commits, 10_000, H).sha).toBe('d4');
  });

  it('retrouve la position, même si des commits sont arrivés au-dessus', () => {
    const a = anchorFor(commits, 75, H);
    expect(scrollTopFor(commits, a, H)).toBe(75);
    expect(scrollTopFor([{ sha: 'n0' }, ...commits], a, H)).toBe(105);
    expect(scrollTopFor(commits, { sha: null, offset: 12 }, H)).toBe(12);
  });

  it('revient en haut si le commit ancré a disparu ou sans ancrage', () => {
    expect(scrollTopFor(commits, { sha: 'zz', offset: 10 }, H)).toBe(0);
    expect(scrollTopFor(commits, null, H)).toBe(0);
    expect(scrollTopFor([], { sha: 'a1', offset: 0 }, H)).toBe(0);
  });

  it('borne le décalage à la hauteur d’une ligne', () => {
    expect(scrollTopFor(commits, { sha: 'a1', offset: 500 }, H)).toBe(30 + 29);
  });
});
