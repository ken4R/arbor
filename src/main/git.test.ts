import { describe, expect, it } from 'vitest';
import { parseNameStatus, parseRefs, parseStatus } from './git';

describe('parseStatus', () => {
  it('sépare indexé, non indexé, non suivi et conflits', () => {
    const out = ['## main...origin/main [ahead 2, behind 1]', 'M  a.txt', ' M b.txt', 'MM c.txt', '?? new.txt', 'UU conflict.txt', 'R  new-name.txt', 'old-name.txt', ''].join('\0');
    const s = parseStatus(out);
    expect(s.branch).toBe('main');
    expect(s.upstream).toBe('origin/main');
    expect([s.ahead, s.behind]).toEqual([2, 1]);
    expect(s.staged.map((f) => f.path)).toEqual(['a.txt', 'c.txt', 'new-name.txt']);
    expect(s.staged[2].oldPath).toBe('old-name.txt');
    expect(s.unstaged.map((f) => `${f.status}${f.path}`)).toEqual(['Mb.txt', 'Mc.txt', '?new.txt']);
    expect(s.conflicted.map((f) => f.path)).toEqual(['conflict.txt']);
  });

  it('gère un dépôt sans commit et une HEAD détachée', () => {
    expect(parseStatus('## No commits yet on main\0').branch).toBe('main');
    expect(parseStatus('## HEAD (no branch)\0').branch).toBeNull();
  });
});

describe('parseRefs', () => {
  it('reconnaît HEAD, branches, remotes et tags', () => {
    expect(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1')).toEqual([
      { name: 'HEAD', type: 'head' },
      { name: 'main', type: 'local' },
      { name: 'origin/main', type: 'remote' },
      { name: 'v1', type: 'tag' },
    ]);
  });
});

describe('parseNameStatus', () => {
  it('gère les renommages', () => {
    expect(parseNameStatus('M\0a\0R100\0old\0new\0')).toEqual([
      { status: 'M', path: 'a' },
      { status: 'R', oldPath: 'old', path: 'new' },
    ]);
  });
});
