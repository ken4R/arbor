import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasLfsAttribute, repoFeatures } from './git';

describe('hasLfsAttribute', () => {
  it('reconnaît filter=lfs (sortie de git lfs track)', () => {
    expect(hasLfsAttribute('*.bin filter=lfs diff=lfs merge=lfs -text\n')).toBe(true);
    expect(hasLfsAttribute('*.txt text\r\nassets/*.psd filter=lfs diff=lfs merge=lfs -text\r\n')).toBe(true);
    expect(hasLfsAttribute('  *.bin\tfilter=lfs  ')).toBe(true);
  });

  it('accepte un motif entre guillemets (espaces, guillemet échappé)', () => {
    expect(hasLfsAttribute('"mes fichiers/*.bin" filter=lfs -text')).toBe(true);
    expect(hasLfsAttribute('"a\\"b c" filter=lfs')).toBe(true);
    expect(hasLfsAttribute('"filter=lfs x" -text')).toBe(false);
  });

  it('ignore commentaires, macros, exclusions et autres filtres', () => {
    expect(hasLfsAttribute('')).toBe(false);
    expect(hasLfsAttribute('# *.bin filter=lfs\n')).toBe(false);
    expect(hasLfsAttribute('[attr]binaire filter=lfs -text\n')).toBe(false);
    expect(hasLfsAttribute('*.bin -filter\n*.psd !filter\n')).toBe(false);
    expect(hasLfsAttribute('*.c filter=indent\n*.bin filter=lfsx\n')).toBe(false);
    // Motif seul nommé comme l'attribut : ce n'est pas un attribut.
    expect(hasLfsAttribute('filter=lfs\n')).toBe(false);
  });
});

describe('repoFeatures', () => {
  const dirs: string[] = [];
  const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), 'arbor-features-'));
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('rien sans .gitmodules, .gitattributes LFS ni dossier lfs', async () => {
    const repo = await tmp();
    await mkdir(join(repo, '.git'));
    await writeFile(join(repo, '.gitattributes'), '*.txt text\n');
    expect(await repoFeatures(repo)).toEqual({ submodules: false, lfs: false });
  });

  it('détecte .gitmodules et filter=lfs du .gitattributes racine', async () => {
    const repo = await tmp();
    await mkdir(join(repo, '.git'));
    await writeFile(join(repo, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n');
    await writeFile(join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    expect(await repoFeatures(repo)).toEqual({ submodules: true, lfs: true });
  });

  it('détecte <gitDir>/lfs, y compris via un fichier .git (worktree lié : dossier commun)', async () => {
    const repo = await tmp();
    await mkdir(join(repo, '.git', 'lfs'), { recursive: true });
    expect((await repoFeatures(repo)).lfs).toBe(true);

    const linked = await tmp();
    await mkdir(join(repo, '.git', 'worktrees', 'w'), { recursive: true });
    await writeFile(join(repo, '.git', 'worktrees', 'w', 'commondir'), '../..\n');
    await writeFile(join(linked, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'w')}\n`);
    expect((await repoFeatures(linked)).lfs).toBe(true);
  });

  it('fichier .git relatif (sous-module) sans commondir', async () => {
    const parent = await tmp();
    await mkdir(join(parent, '.git', 'modules', 'lib', 'lfs'), { recursive: true });
    await mkdir(join(parent, 'lib'));
    await writeFile(join(parent, 'lib', '.git'), 'gitdir: ../.git/modules/lib\n');
    expect(await repoFeatures(join(parent, 'lib'))).toEqual({ submodules: false, lfs: true });
  });
});
