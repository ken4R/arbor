import { describe, expect, it } from 'vitest';
import { groupBlame, isUncommitted } from './blame';

const l = (sha: string, line: number) => ({ sha, origLine: line, line, text: `ligne ${line}` });

describe('groupBlame', () => {
  it('regroupe les lignes consécutives du même commit', () => {
    const groups = groupBlame([l('a', 1), l('a', 2), l('b', 3), l('a', 4), l('a', 5)]);
    expect(groups.map((g) => [g.sha, g.start, g.lines.length])).toEqual([
      ['a', 0, 2],
      ['b', 2, 1],
      ['a', 3, 2],
    ]);
  });

  it('renvoie une liste vide pour un fichier vide', () => {
    expect(groupBlame([])).toEqual([]);
  });
});

describe('isUncommitted', () => {
  it('reconnaît le SHA nul des lignes non commitées', () => {
    expect(isUncommitted('0'.repeat(40))).toBe(true);
    expect(isUncommitted('0a'.repeat(20))).toBe(false);
  });
});
