import { describe, expect, it } from 'vitest';
import { appendRevisions, groupBlame, isUncommitted, nextPageArgs } from './blame';

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

const rev = (sha: string, path: string, oldPath?: string) => ({ sha, parents: [], author: 'A', email: 'a@x', date: 0, subject: sha, path, oldPath, status: (oldPath ? 'R' : 'M') as 'R' | 'M' });

describe("pagination de l'historique", () => {
  it('repart de la dernière version, sous son ancien nom, en sautant ce commit', () => {
    expect(nextPageArgs(rev('c', 'b.txt'))).toEqual({ path: 'b.txt', rev: 'c', skip: 1 });
    expect(nextPageArgs(rev('r', 'b.txt', 'a.txt'))).toEqual({ path: 'a.txt', rev: 'r', skip: 1 });
  });

  it('écarte les SHA déjà chargés', () => {
    const out = appendRevisions([rev('a', 'x'), rev('b', 'x')], [rev('b', 'x'), rev('c', 'x'), rev('c', 'x')]);
    expect(out.map((r) => r.sha)).toEqual(['a', 'b', 'c']);
  });
});
