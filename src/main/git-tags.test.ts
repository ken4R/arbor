import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkout, createTag, deleteRemoteTag, deleteTag, parseLsRemoteTags, pushAllTags, pushTag, remoteTags } from './git';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('parseLsRemoteTags', () => {
  it('lit les tags légers et annotés', () => {
    expect(parseLsRemoteTags(`${A}\trefs/tags/v1.0\n${B}\trefs/tags/v1.1\n`)).toEqual([
      { name: 'v1.0', sha: A },
      { name: 'v1.1', sha: B },
    ]);
  });

  it('garde les noms avec « / », accents et espaces de fin de ligne Windows', () => {
    expect(parseLsRemoteTags(`${A}\trefs/tags/jalon/été\r\n`)).toEqual([{ name: 'jalon/été', sha: A }]);
  });

  it('ignore les entrées déréférencées, les autres références et les lignes vides ou incomplètes', () => {
    const out = [`${A}\trefs/tags/v1.1`, `${B}\trefs/tags/v1.1^{}`, `${A}\trefs/heads/main`, '', 'n importe quoi', `zzz\trefs/tags/x`, `${A}\trefs/tags/`].join('\n');
    expect(parseLsRemoteTags(out)).toEqual([{ name: 'v1.1', sha: A }]);
  });

  it('sortie vide : aucun tag', () => {
    expect(parseLsRemoteTags('')).toEqual([]);
  });
});

describe('tags sur un vrai dépôt', () => {
  let dir = '';
  let remote = '';
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'arbor-tags-'));
    remote = mkdtempSync(join(tmpdir(), 'arbor-tags-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'T');
    g('config', 'user.email', 't@x');
    for (const m of ['un', 'deux']) {
      writeFileSync(join(dir, 'f.txt'), `${m}\n`);
      g('add', '-A');
      g('commit', '-qm', m);
    }
    g('remote', 'add', 'origin', remote);
    g('push', '-q', 'origin', 'main');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('crée un tag annoté (message nettoyé) et un tag léger', async () => {
    const first = g('rev-parse', 'HEAD~1');
    await createTag(dir, 'v1', first, '  Première version\n\n\n');
    await createTag(dir, 'léger', 'HEAD', null);
    expect(g('cat-file', '-t', 'refs/tags/v1')).toBe('tag');
    expect(g('rev-parse', 'v1^{commit}')).toBe(first);
    expect(g('tag', '-l', '--format=%(contents)', 'v1')).toBe('Première version');
    expect(g('cat-file', '-t', 'refs/tags/léger')).toBe('commit');
  });

  it('refuse un tag annoté sans message et un nom invalide', async () => {
    await expect(createTag(dir, 'vide', 'HEAD', '  \n')).rejects.toThrow(/message/);
    await expect(createTag(dir, '-x', 'HEAD', null)).rejects.toThrow(/valide/);
    await expect(createTag(dir, 'a..b', 'HEAD', null)).rejects.toThrow(/valide/);
  });

  it('checkout de refs/tags/<nom> même si une branche porte le même nom', async () => {
    g('branch', 'v1', 'HEAD'); // branche « v1 » sur le dernier commit, tag « v1 » sur le premier
    await checkout(dir, 'refs/tags/v1');
    expect(g('rev-parse', 'HEAD')).toBe(g('rev-parse', 'refs/tags/v1^{commit}'));
    expect(g('rev-parse', 'HEAD')).not.toBe(g('rev-parse', 'refs/heads/v1'));
    await checkout(dir, 'main');
    g('branch', '-D', 'v1');
    await expect(checkout(dir, 'refs/tags/absent')).rejects.toThrow(/n'existe pas/);
  });

  it('pousse un tag, liste les tags distants, supprime en distant puis en local', async () => {
    await pushTag(dir, 'origin', 'v1');
    expect((await remoteTags(dir, 'origin')).map((t) => t.name)).toEqual(['v1']);
    await pushAllTags(dir, 'origin');
    expect((await remoteTags(dir, 'origin')).map((t) => t.name).sort()).toEqual(['léger', 'v1']);
    await deleteRemoteTag(dir, 'origin', 'v1');
    expect((await remoteTags(dir, 'origin')).map((t) => t.name)).toEqual(['léger']);
    await deleteTag(dir, 'v1');
    expect(g('tag', '-l', 'v1')).toBe('');
  });

  it('refuse un remote inconnu (une URL à la place d’un nom) et un tag absent', async () => {
    await expect(pushTag(dir, remote, 'léger')).rejects.toThrow(/remote/);
    await expect(remoteTags(dir, 'nulle-part')).rejects.toThrow(/remote/);
    await expect(deleteTag(dir, 'absent')).rejects.toThrow(/n'existe pas/);
    await expect(deleteRemoteTag(dir, 'nulle-part', 'léger')).rejects.toThrow(/remote/);
  });
});
