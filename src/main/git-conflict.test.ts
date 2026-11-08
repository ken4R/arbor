import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeResult, merge3, splitLines } from '../shared/merge3';
import { conflictVersions, parseUnmerged, resolveDeletion, saveResolution } from './git';

const SHA = (c: string) => c.repeat(40);

describe('parseUnmerged', () => {
  it('trois étages', () => {
    const out = `100644 ${SHA('a')} 1\tf.txt\x00100644 ${SHA('b')} 2\tf.txt\x00100755 ${SHA('c')} 3\tf.txt\0`;
    expect(parseUnmerged(out)).toEqual([
      { mode: '100644', sha: SHA('a'), stage: 1, path: 'f.txt' },
      { mode: '100644', sha: SHA('b'), stage: 2, path: 'f.txt' },
      { mode: '100755', sha: SHA('c'), stage: 3, path: 'f.txt' },
    ]);
  });
  it('sans base (ajouté des deux côtés) et sans étage 2 (supprimé de mon côté)', () => {
    expect(parseUnmerged(`100644 ${SHA('b')} 2\tn.txt\x00100644 ${SHA('c')} 3\tn.txt\0`).map((e) => e.stage)).toEqual([2, 3]);
    expect(parseUnmerged(`100644 ${SHA('a')} 1\td.js\x00100644 ${SHA('c')} 3\td.js\0`).map((e) => e.stage)).toEqual([1, 3]);
  });
  it('chemins avec espaces, accents et tabulation (pas de guillemets avec -z)', () => {
    const out = `100644 ${SHA('a')} 1\tdossier é/mon fichier.txt\x00160000 ${SHA('d')} 2\tsous\tmodule\0`;
    expect(parseUnmerged(out).map((e) => [e.path, e.mode])).toEqual([
      ['dossier é/mon fichier.txt', '100644'],
      ['sous\tmodule', '160000'],
    ]);
  });
  it('sortie vide ou ligne illisible', () => {
    expect(parseUnmerged('')).toEqual([]);
    expect(parseUnmerged('n importe quoi\0')).toEqual([]);
  });
});

describe('conflits sur un vrai dépôt', () => {
  let dir = '';
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_EDITOR: 'true' };
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const tryG = (...args: string[]) => {
    try {
      g(...args);
    } catch {
      /* conflit attendu */
    }
  };
  const write = (f: string, s: string) => writeFileSync(join(dir, f), s);
  const commitAll = (msg: string) => {
    g('add', '-A');
    g('commit', '-q', '--allow-empty', '-m', msg);
  };
  /** Dépôt : base sur main, `autre` et main modifient `f` différemment. */
  const setup = (file: string, base: string, mine: string, theirs: string) => {
    dir = mkdtempSync(join(tmpdir(), 'arbor-conflict-'));
    g('init', '-q', '-b', 'main');
    g('config', 'core.autocrlf', 'false');
    write(file, base);
    commitAll('base');
    g('checkout', '-qb', 'autre');
    write(file, theirs);
    commitAll('leur');
    g('checkout', '-q', 'main');
    write(file, mine);
    commitAll('ma');
  };
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fusion : ma version = étage 2, enregistrement puis marquage résolu', async () => {
    setup('f.txt', 'a\nb\nc\n', 'a\nB-main\nc\n', 'a\nB-autre\nc\n');
    tryG('merge', 'autre');
    const v = await conflictVersions(dir, 'f.txt');
    expect(v).toMatchObject({ base: 'a\nb\nc\n', mine: 'a\nB-main\nc\n', theirs: 'a\nB-autre\nc\n', binary: false, tooLarge: false });
    expect(v.workingHash).toMatch(/^[0-9a-f]{40}$/);
    const hash = await saveResolution(dir, 'f.txt', 'a\nB-main\nB-autre\nc\n', v.workingHash, false);
    expect(g('ls-files', '-u')).not.toBe(''); // toujours en conflit
    // Une deuxième sauvegarde part de l'empreinte renvoyée.
    await saveResolution(dir, 'f.txt', 'a\nfinal\nc\n', hash, true);
    expect(g('ls-files', '-u')).toBe('');
    expect(g('diff', '--cached', '--name-only')).toBe('f.txt\n');
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('a\nfinal\nc\n');
  });

  it('refuse d’écraser un fichier modifié depuis le chargement', async () => {
    setup('f.txt', 'a\n', 'm\n', 't\n');
    tryG('merge', 'autre');
    const v = await conflictVersions(dir, 'f.txt');
    write('f.txt', 'édité dans un éditeur\n');
    await expect(saveResolution(dir, 'f.txt', 'x\n', v.workingHash, true)).rejects.toThrow(/modifié hors de l'éditeur/);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('édité dans un éditeur\n');
  });

  it('rebase : ma version = étage 3 (côtés inversés)', async () => {
    setup('f.txt', 'a\nb\nc\n', 'a\nB-main\nc\n', 'a\nB-autre\nc\n');
    // On rebase main (ma branche) sur autre : git rejoue mon commit, « ours » = autre.
    tryG('rebase', 'autre');
    const v = await conflictVersions(dir, 'f.txt');
    expect(v.mine).toBe('a\nB-main\nc\n');
    expect(v.theirs).toBe('a\nB-autre\nc\n');
    expect(v.base).toBe('a\nb\nc\n');
  });

  it('CRLF : fusion et enregistrement conservent les fins de ligne et le saut final', async () => {
    // Les deux côtés modifient la ligne 2 ; leur version ajoute une ligne en fin (sans conflit).
    setup('w.txt', 'un\r\ndeux\r\ntrois\r\n', 'un\r\nDEUX-m\r\ntrois\r\n', 'un\r\nDEUX-t\r\ntrois\r\nquatre\r\n');
    tryG('merge', 'autre');
    const v = await conflictVersions(dir, 'w.txt');
    const mine = splitLines(v.mine!);
    expect(mine.eol).toBe('\r\n');
    const blocks = merge3(splitLines(v.base!).lines, mine.lines, splitLines(v.theirs!).lines);
    const conflictAt = blocks.findIndex((b) => b.kind === 'conflict');
    const text = composeResult(blocks, new Map([[conflictAt, 'mine' as const]]), mine.eol, mine.finalNewline);
    expect(text).toBe('un\r\nDEUX-m\r\ntrois\r\nquatre\r\n');
    await saveResolution(dir, 'w.txt', text, v.workingHash, true);
    expect(readFileSync(join(dir, 'w.txt'), 'utf8')).toBe('un\r\nDEUX-m\r\ntrois\r\nquatre\r\n');
  });

  it('suppression/modification : version absente, garder ou supprimer', async () => {
    setup('d.js', 'v1\n', 'v2\n', 'v1\n');
    g('checkout', '-q', 'autre');
    g('rm', '-q', 'd.js');
    g('commit', '-qm', 'supprime');
    g('checkout', '-q', 'main');
    tryG('merge', 'autre');
    const v = await conflictVersions(dir, 'd.js');
    expect(v).toMatchObject({ base: 'v1\n', mine: 'v2\n', theirs: null });
    await expect(saveResolution(dir, 'nexiste.pas', '', null, true)).rejects.toThrow(/n'est plus en conflit/);
    await resolveDeletion(dir, 'd.js', false);
    expect(existsSync(join(dir, 'd.js'))).toBe(false);
    expect(g('ls-files', '-u')).toBe('');
    expect(g('status', '--porcelain')).toBe('D  d.js\n'); // suppression indexée
  });

  it('suppression/modification : garder le fichier', async () => {
    setup('d.js', 'v1\n', 'v1\n', 'v2\n');
    g('rm', '-q', 'd.js');
    g('commit', '-qm', 'supprime ici');
    tryG('merge', 'autre');
    const v = await conflictVersions(dir, 'd.js');
    expect(v).toMatchObject({ mine: null, theirs: 'v2\n' });
    await resolveDeletion(dir, 'd.js', true);
    expect(g('ls-files', '-u')).toBe('');
    expect(readFileSync(join(dir, 'd.js'), 'utf8')).toBe('v2\n');
  });

  it('binaire et chemin avec espace, accent et caractère de motif', async () => {
    setup('é [x] *.bin', 'a\0b', 'a\0c', 'a\0d');
    tryG('merge', 'autre');
    const v = await conflictVersions(dir, 'é [x] *.bin');
    expect(v).toMatchObject({ binary: true, base: '', mine: '', theirs: '' });
  });
});
