import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDiff } from '../shared/diff';
import {
  applyPatchSelection,
  buildSubmodules,
  diff,
  normalizeSubmodulePath,
  parseGitmodules,
  parseLsFilesStage,
  parseSubmoduleStatusV2,
  submoduleHead,
  submoduleReset,
  submoduleRoot,
  submodules,
  submoduleState,
  submoduleSync,
  submoduleInit,
  status,
  translateGitError,
} from './git';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('parseGitmodules', () => {
  it('lit nom, chemin, URL et branche (sortie réelle de git config -z)', () => {
    const out = 'submodule.vendor/lib.path\nvendor/lib\0submodule.vendor/lib.url\n../demo-lib.git\0submodule.vendor/lib.branch\nmain\0';
    expect(parseGitmodules(out)).toEqual([{ name: 'vendor/lib', path: 'vendor/lib', url: '../demo-lib.git', branch: 'main' }]);
  });

  it('nom avec des points : coupé au dernier point', () => {
    const out = 'submodule.a.b.c.path\nlibs/abc\0submodule.a.b.c.url\nhttps://exemple.org/abc.git\0';
    expect(parseGitmodules(out)).toEqual([{ name: 'a.b.c', path: 'libs/abc', url: 'https://exemple.org/abc.git', branch: null }]);
  });

  it('chemins avec espaces et UTF-8 ; dernière valeur gagnante ; barre finale retirée', () => {
    const out = 'submodule.x.path\nancien\0submodule.x.path\nma lib/é té/\0submodule.x.URL\nu\0';
    expect(parseGitmodules(out)).toEqual([{ name: 'x', path: 'ma lib/é té', url: 'u', branch: null }]);
  });

  it('écarte les entrées sans chemin, les chemins dangereux et les doublons de chemin', () => {
    const out = [
      'submodule.sans.url\nu',
      'submodule.haut.path\n../dehors',
      'submodule.abs.path\n/etc',
      'submodule.git.path\nx/.git',
      'submodule.ok.path\nlib',
      'submodule.double.path\nlib',
      'submodule.bool.update',
      'autre.cle\nv',
      'submodule..path\nvide',
    ].join('\0');
    expect(parseGitmodules(out)).toEqual([{ name: 'ok', path: 'lib', url: null, branch: null }]);
  });

  it('sortie vide (aucune entrée, code 1) : liste vide', () => {
    expect(parseGitmodules('')).toEqual([]);
  });
});

describe('normalizeSubmodulePath', () => {
  it('refuse les détours et caractères de contrôle', () => {
    for (const p of ['', '/', '..', 'a/../b', './a', 'a//b', 'C:/x', 'a\\b', 'a\nb', '.GIT/x']) expect(normalizeSubmodulePath(p)).toBeNull();
    expect(normalizeSubmodulePath('vendor/lib//')).toBe('vendor/lib');
    expect(normalizeSubmodulePath('-x/ é')).toBe('-x/ é');
  });
});

describe('parseLsFilesStage', () => {
  it('lit étage 0 et étages de conflit', () => {
    const out = `160000 ${A} 0\tvendor/lib\x00160000 ${A} 1\tvendor/x y\x00160000 ${B} 2\tvendor/x y\x00160000 ${C} 3\tvendor/x y\x00100644 ${A} 0\tvendor/lib2/f\x00bad\x00`;
    expect(parseLsFilesStage(out)).toEqual([
      { mode: '160000', sha: A, stage: 0, path: 'vendor/lib' },
      { mode: '160000', sha: A, stage: 1, path: 'vendor/x y' },
      { mode: '160000', sha: B, stage: 2, path: 'vendor/x y' },
      { mode: '160000', sha: C, stage: 3, path: 'vendor/x y' },
      { mode: '100644', sha: A, stage: 0, path: 'vendor/lib2/f' },
    ]);
  });
});

describe('parseSubmoduleStatusV2', () => {
  it('lit les indicateurs S<c><m><u> (sortie réelle) et ignore les fichiers ordinaires', () => {
    const out = [
      `1 .M SCM. 160000 160000 160000 ${A} ${A} vendor/lib`,
      `1 .M S..U 160000 160000 160000 ${B} ${B} vendor/ma lib`,
      `1 .M N... 100644 100644 100644 ${A} ${A} README.md`,
      `2 R. S... 160000 160000 160000 ${A} ${A} R100 nouveau`,
      'ancien',
      `u UU SC.. 160000 160000 160000 160000 ${A} ${B} ${C} vendor/conflit`,
      '? notes.txt',
      '',
    ].join('\0');
    const m = parseSubmoduleStatusV2(out);
    expect([...m.keys()]).toEqual(['vendor/lib', 'vendor/ma lib', 'nouveau', 'vendor/conflit']);
    expect(m.get('vendor/lib')).toEqual({ commitChanged: true, modified: true, untracked: false, conflict: false });
    expect(m.get('vendor/ma lib')).toEqual({ commitChanged: false, modified: false, untracked: true, conflict: false });
    expect(m.get('vendor/conflit')?.conflict).toBe(true);
  });
});

describe('submoduleState / buildSubmodules', () => {
  const flags = (o: Partial<{ commitChanged: boolean; modified: boolean; untracked: boolean; conflict: boolean }> = {}) => ({
    commitChanged: false,
    modified: false,
    untracked: false,
    conflict: false,
    ...o,
  });

  it('ordre de priorité : conflit, absent, non initialisé, commit différent', () => {
    expect(submoduleState({ inIndex: true, conflict: true, initialized: true })).toBe('conflict');
    expect(submoduleState({ inIndex: true, conflict: false, initialized: true, flags: flags({ conflict: true }) })).toBe('conflict');
    expect(submoduleState({ inIndex: false, conflict: false, initialized: true })).toBe('missing');
    expect(submoduleState({ inIndex: true, conflict: false, initialized: false, flags: flags({ commitChanged: true }) })).toBe('uninitialized');
    expect(submoduleState({ inIndex: true, conflict: false, initialized: true, flags: flags({ commitChanged: true }) })).toBe('changed');
    expect(submoduleState({ inIndex: true, conflict: false, initialized: true, flags: flags({ modified: true }) })).toBe('ok');
  });

  it('assemble : SHA attendu, dirty seulement si initialisé', () => {
    const entries = [
      { name: 'a', path: 'a', url: null, branch: null },
      { name: 'b', path: 'b', url: null, branch: null },
      { name: 'c', path: 'c', url: null, branch: null },
    ];
    const index = parseLsFilesStage(`160000 ${A} 0\ta\x00160000 ${B} 0\tb\x00160000 ${A} 1\tc\x00160000 ${B} 2\tc\x00`);
    const status = new Map([
      ['a', flags({ modified: true })],
      ['b', flags({ modified: true })],
    ]);
    const subs = buildSubmodules(entries, index, status, (p) => p !== 'b');
    expect(subs.map((s) => [s.path, s.state, s.expected, s.dirty])).toEqual([
      ['a', 'ok', A, true],
      ['b', 'uninitialized', B, false],
      ['c', 'conflict', null, false],
    ]);
  });
});

describe('translateGitError (sous-modules)', () => {
  it('traduit le refus du transport file', () => {
    const raw = "Cloning into '/x/vendor/lib'...\nfatal: transport 'file' not allowed\nfatal: clone of '/x/lib' into submodule path '/x/vendor/lib' failed";
    expect(translateGitError(raw)).toMatch(/transport « file ».*protocol\.file\.allow/);
  });
});

describe('sous-modules sur un vrai dépôt', () => {
  let root = '';
  let lib = '';
  let dir = '';
  const SUB = 'vendor/ma lib é';
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  // Uniquement dans les tests : autoriser le clonage d'un sous-module local.
  const allow = ['-c', 'protocol.file.allow=always'];
  const commit = (cwd: string, file: string, text: string, msg: string) => {
    writeFileSync(join(cwd, file), text);
    run(cwd, 'add', '--', file);
    run(cwd, 'commit', '-q', '-m', msg);
    return run(cwd, 'rev-parse', 'HEAD');
  };
  let shas: string[] = [];

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'arbor-sub-')));
    lib = join(root, 'lib');
    dir = join(root, 'parent');
    for (const d of [lib, dir]) {
      mkdirSync(d);
      run(d, 'init', '-q', '-b', 'main');
      run(d, 'config', 'user.name', 'Test');
      run(d, 'config', 'user.email', 't@example.com');
    }
    shas = [commit(lib, 'lib.txt', '1\n', 'un'), commit(lib, 'lib.txt', '2\n', 'deux'), commit(lib, 'lib.txt', '3\n', 'trois')];
    commit(dir, 'README.md', 'parent\n', 'init');
    run(dir, ...allow, 'submodule', 'add', '-q', '--name', 'ma.lib.v2', lib, SUB);
    run(dir, ...allow, 'submodule', 'add', '-q', lib, 'vendor/outils');
    run(dir, 'commit', '-q', '-m', 'sous-modules');
    run(dir, 'submodule', 'deinit', '-q', '-f', 'vendor/outils');
    // Un utilisateur qui préfère `diff.submodule=log` ne doit pas casser l'analyse.
    run(dir, 'config', 'diff.submodule', 'log');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('état initial : ok et non initialisé, nom avec points, chemin avec espaces et accents', async () => {
    const subs = await submodules(dir);
    expect(subs.map((s) => [s.name, s.path, s.state, s.initialized, s.expected])).toEqual([
      ['ma.lib.v2', SUB, 'ok', true, shas[2]],
      ['vendor/outils', 'vendor/outils', 'uninitialized', false, shas[2]],
    ]);
    expect(await submoduleHead(dir, SUB)).toBe(shas[2]);
    expect(await submoduleHead(dir, 'vendor/outils')).toBeNull();
  });

  it('commit différent, fichier modifié et non suivi', async () => {
    run(join(dir, SUB), 'checkout', '-q', shas[1]);
    writeFileSync(join(dir, SUB, 'lib.txt'), 'modifié\n');
    writeFileSync(join(dir, SUB, 'nouveau.txt'), 'x\n');
    const [s] = await submodules(dir);
    expect([s.state, s.dirty, s.untracked]).toEqual(['changed', true, true]);
    expect(await submoduleHead(dir, SUB)).toBe(shas[1]);
    // Statut détaillé limité aux chemins signalés par le rendu : hors liste, « à jour » sans lancer `status`.
    expect((await submodules(dir, []))[0].state).toBe('ok');
    expect((await submodules(dir, [SUB]))[0].state).toBe('changed');
  });

  it('initialiser ne déplace jamais un sous-module déjà initialisé (autre commit extrait)', async () => {
    run(dir, 'config', 'submodule.ma.lib.v2.update', 'rebase');
    await expect(submoduleInit(dir, SUB)).rejects.toThrow(/Revenir au commit attendu/);
    expect(await submoduleHead(dir, SUB)).toBe(shas[1]);
    run(dir, 'config', '--unset', 'submodule.ma.lib.v2.update');
  });

  it('diff : --submodule=short forcé, carte analysable, indexation partielle refusée', async () => {
    const target = { kind: 'working' as const, path: SUB, staged: false };
    const raw = await diff(dir, target);
    expect(raw).toContain('Subproject commit');
    expect(parseDiff(raw).submodule).toEqual({ old: shas[2], new: shas[1], dirty: true });
    await expect(applyPatchSelection(dir, target, raw, [{ hunk: 0 }], 'stage')).rejects.toThrow(/Sous-module/);
  });

  it('revenir au commit attendu : refusé si les modifications seraient écrasées, sinon checkout', async () => {
    await expect(submoduleReset(dir, SUB, shas[2])).rejects.toThrow(/modifications locales seraient écrasées/);
    run(join(dir, SUB), 'checkout', '-q', '--', 'lib.txt');
    await expect(submoduleReset(dir, SUB, shas[0])).rejects.toThrow(/Le commit attendu a changé/);
    expect(await submoduleHead(dir, SUB)).toBe(shas[1]);
    await submoduleReset(dir, SUB, shas[2]);
    const [s] = await submodules(dir);
    expect([s.state, s.dirty, s.untracked]).toEqual(['ok', false, true]);
    expect(await submoduleHead(dir, SUB)).toBe(shas[2]);
  });

  it('fichiers non suivis seuls : présents dans le statut du dépôt, diff vide (la carte vient de l’état)', async () => {
    expect((await status(dir)).unstaged.map((f) => f.path)).toContain(SUB);
    expect((await submodules(dir, [SUB]))[0]).toMatchObject({ state: 'ok', dirty: false, untracked: true });
    expect(await diff(dir, { kind: 'working', path: SUB, staged: false })).toBe('');
  });

  it('même commit et modification seule : diff « -dirty » reconnu', async () => {
    writeFileSync(join(dir, SUB, 'lib.txt'), 'encore\n');
    const raw = await diff(dir, { kind: 'working', path: SUB, staged: false });
    expect(parseDiff(raw).submodule).toEqual({ old: shas[2], new: shas[2], dirty: true });
    run(join(dir, SUB), 'checkout', '-q', '--', 'lib.txt');
  });

  it('diff d’un commit qui ajoute le sous-module', async () => {
    const sha = run(dir, 'rev-parse', 'HEAD');
    const raw = await diff(dir, { kind: 'commit', sha, path: SUB });
    expect(parseDiff(raw).submodule).toEqual({ old: null, new: shas[2], dirty: false });
  });

  it('chemins revérifiés : refuse un chemin non déclaré et un sous-module non initialisé', async () => {
    await expect(submoduleInit(dir, '../ailleurs')).rejects.toThrow(/n'est pas un sous-module/);
    await expect(submoduleRoot(dir, 'vendor/outils')).rejects.toThrow(/n'est pas initialisé/);
    await expect(submoduleReset(dir, 'vendor/outils', shas[2])).rejects.toThrow(/n'est pas initialisé/);
    await expect(submoduleRoot(dir, 'README.md')).rejects.toThrow(/n'est pas un sous-module/);
    expect(await submoduleRoot(dir, SUB)).toBe(join(dir, SUB));
  });

  it('initialisation de tous les manquants (module déjà cloné dans .git/modules) et synchronisation', async () => {
    run(join(dir, SUB), 'checkout', '-q', shas[1]);
    await submoduleInit(dir, null);
    const subs = await submodules(dir);
    expect(subs.map((s) => s.state)).toEqual(['changed', 'ok']);
    expect(await submoduleHead(dir, SUB)).toBe(shas[1]); // le sous-module initialisé n'a pas bougé
    await expect(submoduleInit(dir, null)).rejects.toThrow(/Aucun sous-module à initialiser/);
    await submoduleReset(dir, SUB, shas[2]);
    expect(existsSync(join(dir, 'vendor/outils/lib.txt'))).toBe(true);
    await submoduleSync(dir);
  });

  it('clone neuf : le transport file refusé par Git donne un message en français', async () => {
    const clone = join(root, 'clone');
    run(root, 'clone', '-q', dir, clone);
    expect((await submodules(clone)).map((s) => s.state)).toEqual(['uninitialized', 'uninitialized']);
    await expect(submoduleInit(clone, null)).rejects.toThrow(/transport « file »/);
  });

  it('conflit sur le gitlink et sous-module absent de l’index', async () => {
    run(dir, 'checkout', '-q', '-b', 'autre');
    run(join(dir, SUB), 'checkout', '-q', shas[0]);
    run(dir, 'commit', '-q', '-am', 'lib sur un');
    run(dir, 'checkout', '-q', 'main');
    run(dir, 'submodule', 'update', '-q', '--', SUB);
    run(join(dir, SUB), 'checkout', '-q', shas[1]);
    run(dir, 'commit', '-q', '-am', 'lib sur deux');
    expect(() => run(dir, 'merge', '-q', 'autre')).toThrow();
    let [s] = await submodules(dir);
    expect([s.state, s.expected]).toEqual(['conflict', null]);
    await expect(submoduleReset(dir, SUB, shas[1])).rejects.toThrow(/Aucun commit attendu/);
    await expect(submoduleRoot(dir, SUB)).rejects.toThrow(/Aucun commit attendu/);
    run(dir, 'merge', '--abort');
    run(dir, 'rm', '-q', '--cached', '--', SUB);
    [s] = await submodules(dir);
    expect(s.state).toBe('missing');
  });

  it('sans .gitmodules : aucun lancement, liste vide', async () => {
    expect(await submodules(lib)).toEqual([]);
  });
});

describe('sous-modules : chemins piégés et changement de type', () => {
  let root = '';
  let lib = '';
  let dir = '';
  let shas: string[] = [];
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const allow = ['-c', 'protocol.file.allow=always'];
  const init = (d: string) => {
    mkdirSync(d);
    run(d, 'init', '-q', '-b', 'main');
    run(d, 'config', 'user.name', 'Test');
    run(d, 'config', 'user.email', 't@example.com');
  };
  const commit = (cwd: string, file: string, text: string, msg: string) => {
    writeFileSync(join(cwd, file), text);
    run(cwd, 'add', '--', file);
    run(cwd, 'commit', '-q', '-m', msg);
    return run(cwd, 'rev-parse', 'HEAD');
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'arbor-sub2-')));
    lib = join(root, 'lib');
    dir = join(root, 'parent');
    init(lib);
    init(dir);
    init(join(root, 'autre'));
    commit(join(root, 'autre'), 'a.txt', 'a\n', 'autre');
    shas = [commit(lib, 'lib.txt', '1\n', 'un'), commit(lib, 'lib.txt', '2\n', 'deux')];
    commit(dir, 'fichier', 'texte\n', 'init');
    run(dir, ...allow, 'submodule', 'add', '-q', lib, 'lit*');
    run(dir, ...allow, 'submodule', 'add', '-q', lib, 'litA');
    run(dir, 'commit', '-q', '-m', 'sous-modules');
    run(dir, 'submodule', 'deinit', '-q', '-f', '--', 'lit*', 'litA');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('chemins pris à la lettre (`*`) pour initialiser et revenir au commit attendu', async () => {
    await submoduleInit(dir, 'lit*');
    expect((await submodules(dir)).map((s) => [s.path, s.state])).toEqual([
      ['lit*', 'ok'],
      ['litA', 'uninitialized'],
    ]);
    run(join(dir, 'lit*'), 'checkout', '-q', shas[0]);
    await submoduleReset(dir, 'lit*', shas[1]);
    expect(await submoduleHead(dir, 'lit*')).toBe(shas[1]);
    expect((await submodules(dir))[1].state).toBe('uninitialized');
  });

  it('lien symbolique déclaré comme chemin : jamais considéré comme initialisé ni ouvert', async () => {
    symlinkSync('../autre', join(dir, 'ext'));
    run(dir, 'config', '-f', '.gitmodules', 'submodule.ext.path', 'ext');
    let ext = (await submodules(dir)).find((s) => s.path === 'ext')!;
    expect([ext.state, ext.initialized]).toEqual(['missing', false]);
    await expect(submoduleRoot(dir, 'ext')).rejects.toThrow(/Aucun commit attendu/);
    run(dir, 'update-index', '--add', '--cacheinfo', `160000,${shas[0]},ext`);
    ext = (await submodules(dir)).find((s) => s.path === 'ext')!;
    expect([ext.state, ext.initialized]).toEqual(['uninitialized', false]);
    await expect(submoduleRoot(dir, 'ext')).rejects.toThrow(/n'est pas initialisé/);
    expect(await submoduleHead(dir, 'ext')).toBeNull();
    await expect(submoduleReset(dir, 'ext', shas[0])).rejects.toThrow(/n'est pas initialisé/);
  });

  it('fichier remplacé par un gitlink : carte de sous-module, indexation partielle refusée', async () => {
    run(dir, 'rm', '-q', '--cached', '--', 'fichier');
    rmSync(join(dir, 'fichier'));
    run(dir, 'update-index', '--add', '--cacheinfo', `160000,${shas[1]},fichier`);
    const target = { kind: 'working' as const, path: 'fichier', staged: true };
    const raw = await diff(dir, target);
    expect(parseDiff(raw).submodule).toEqual({ old: null, new: shas[1], dirty: false, typeChange: true });
    await expect(applyPatchSelection(dir, target, raw, [{ hunk: 0 }], 'unstage')).rejects.toThrow(/Sous-module/);
  });
});
