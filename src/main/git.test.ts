import { describe, expect, it } from 'vitest';
import { gitSide, parseLog, parseNameStatus, parseRefs, parseRemotes, parseStatus, parseTags, pushRemote, translateGitError } from './git';

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

describe('translateGitError', () => {
  it('traduit les erreurs courantes', () => {
    expect(translateGitError("error: the branch 'fix/typo' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D fix/typo'.")).toBe(
      "La branche « fix/typo » n'est pas entièrement fusionnée. Cochez « Forcer » pour la supprimer quand même.",
    );
    expect(translateGitError(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs")).toMatch(/^Push refusé/);
    expect(translateGitError("fatal: a branch named 'x' already exists")).toBe('« x » existe déjà.');
    expect(translateGitError("fatal: tag 'v1' already exists")).toBe('« v1 » existe déjà.');
    expect(translateGitError("fatal: 'a b' is not a valid branch name")).toMatch(/^Nom invalide/);
  });

  it('garde la fin du message brut sinon', () => {
    expect(translateGitError('a\nb\nc\nd\ne\nfatal: inconnu')).toBe('Git a renvoyé une erreur :\nc\nd\ne\nfatal: inconnu');
  });
});

describe('parseLog', () => {
  const FS = '\x1f';
  const rec = (sha: string, parents: string, refs: string, message: string) => [sha, parents, 'Léa', 'lea@example.com', '1700000000', refs, message].join(FS);

  it('sépare résumé et corps, même si le corps contient des séparateurs', () => {
    const out = [rec('a1', 'b2 c3', 'HEAD -> refs/heads/main', `Résumé\n\nCorps avec ${FS} séparateur\x1e et lignes\n`), rec('b2', '', '', 'Racine')].join('\0') + '\0';
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ sha: 'a1', parents: ['b2', 'c3'], subject: 'Résumé', body: `Corps avec ${FS} séparateur\x1e et lignes` });
    expect(commits[0].refs.map((r) => r.name)).toEqual(['HEAD', 'main']);
    expect(commits[1]).toMatchObject({ sha: 'b2', parents: [], subject: 'Racine', body: '' });
  });
});

describe('gitSide', () => {
  it('inverse ours et theirs pendant un rebase', () => {
    expect(gitSide('merging', 'mine')).toBe('ours');
    expect(gitSide('merging', 'theirs')).toBe('theirs');
    expect(gitSide('rebasing', 'mine')).toBe('theirs');
    expect(gitSide('rebasing', 'theirs')).toBe('ours');
  });
});

describe('pushRemote', () => {
  it('préfère origin, sinon l’unique remote', () => {
    expect(pushRemote(['upstream', 'origin'])).toBe('origin');
    expect(pushRemote(['upstream'])).toBe('upstream');
    expect(() => pushRemote(['a', 'b'])).toThrow(/Plusieurs remotes/);
    expect(() => pushRemote([])).toThrow(/Aucun remote/);
  });
});

describe('parseTags', () => {
  const rec = (...f: string[]) => f.join('\x1f') + '\x1e';
  const C = 'c'.repeat(40);
  const T = 't'.repeat(40);

  it('tag léger, annoté, sur un arbre, imbriqué', () => {
    const out =
      [
        rec('v1.1', 'tag', T, C, 'commit', 'Version 1.1', '1700000100'),
        rec('v1.0', 'commit', C, '', '', 'sujet du commit', '1700000000'),
        rec('arbre', 'tree', 'e'.repeat(40), '', '', '', ''),
        rec('imbrique', 'tag', 'f'.repeat(40), T, 'tag', 'n', '1700000200'),
      ].join('\n') + '\n';
    expect(parseTags(out)).toEqual([
      { name: 'v1.1', sha: C, annotated: true, subject: 'Version 1.1', date: 1700000100 },
      { name: 'v1.0', sha: C, annotated: false, subject: '', date: 1700000000 },
      { name: 'arbre', sha: null, annotated: false, subject: '', date: 0 },
      { name: 'imbrique', sha: null, annotated: true, subject: 'n', date: 1700000200 },
    ]);
  });

  it('noms avec / ou accents, sortie vide', () => {
    const out = rec('release/2.0', 'commit', C, '', '', 'x', '1') + '\n' + rec('été-2024', 'tag', T, C, 'commit', 'Sortie d’été', '2') + '\n';
    expect(parseTags(out).map((t) => [t.name, t.sha])).toEqual([
      ['release/2.0', C],
      ['été-2024', C],
    ]);
    expect(parseTags('')).toEqual([]);
  });
});

describe('parseRemotes', () => {
  it('URL de fetch et de push distinctes, remote sans URL, URL avec espaces', () => {
    const names = 'miroir\norigin\nsansurl\n';
    const verbose = [
      'miroir\t/chemin/avec des espaces/depot.git (fetch)',
      'miroir\t/chemin/avec des espaces/depot.git (push)',
      'origin\thttps://exemple.org/a.git (fetch)',
      'origin\tssh://git@exemple.org/a.git (push)',
      'sansurl\t',
      '',
    ].join('\n');
    expect(parseRemotes(names, verbose)).toEqual([
      { name: 'miroir', fetchUrl: '/chemin/avec des espaces/depot.git', pushUrl: null },
      { name: 'origin', fetchUrl: 'https://exemple.org/a.git', pushUrl: 'ssh://git@exemple.org/a.git' },
      { name: 'sansurl', fetchUrl: null, pushUrl: null },
    ]);
  });

  it('plusieurs URL : la première est retenue ; aucun remote', () => {
    const verbose = 'o\thttps://a (fetch)\no\thttps://a (push)\no\thttps://b (push)\n';
    expect(parseRemotes('o\n', verbose)).toEqual([{ name: 'o', fetchUrl: 'https://a', pushUrl: null }]);
    expect(parseRemotes('', '')).toEqual([]);
  });
});
