import { describe, expect, it } from 'vitest';
import { gitSide, parseLog, parseNameStatus, parseRefs, parseStatus, pushRemote, translateGitError } from './git';

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
