import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { lfsPointerChange, lfsPullArgs } from '../shared/lfs';
import {
  applyPatchSelection,
  diff,
  forgetLfsVersion,
  GitError,
  isLfsMissing,
  lfsFiles,
  lfsInfo,
  lfsPull,
  lfsTrack,
  snapshot,
  status,
  translateGitError,
} from './git';

const lfsInstalled = (() => {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('translateGitError (lfs)', () => {
  it('git-lfs introuvable : messages réels du filtre, du hook et de git', () => {
    for (const raw of [
      'git-lfs filter-process: 1: git-lfs: not found\nfatal: the remote end hung up unexpectedly',
      'git-lfs filter-process: git-lfs: command not found\nfatal: the remote end hung up unexpectedly',
      "This repository is configured for Git LFS but 'git-lfs' was not found on your path.",
      "git: 'lfs' is not a git command. See 'git --help'.",
    ])
      expect(translateGitError(raw)).toMatch(/^git-lfs n'est pas installé/);
  });

  it('filtre git-lfs présent mais en échec : message distinct, pas de repli « sans LFS »', () => {
    for (const raw of [
      "Error downloading object: a.bin (2c8b08d): Smudge error: Error downloading a.bin: object does not exist\nerror: external filter 'git-lfs filter-process' failed\nfatal: a.bin: smudge filter lfs failed",
      'fatal: a.bin: smudge filter lfs failed',
    ]) {
      expect(translateGitError(raw)).toMatch(/^Le filtre LFS a échoué/);
      expect(isLfsMissing(new GitError('', raw))).toBe(false);
    }
  });
});

// Délai élargi : git-lfs lance plusieurs processus git par appel (lent sur une machine chargée).
describe.skipIf(!lfsInstalled)('LFS (git-lfs installé)', { timeout: 20_000 }, () => {
  let root: string;
  let dir: string;
  let remote: string;
  /** Diagnostic joint aux assertions qui dépendent du comportement de git-lfs (versions différentes en CI). */
  const lfsState = () => {
    const out = (...args: string[]) => {
      try {
        return run(dir, ...args);
      } catch (e) {
        return `échec : ${(e as Error).message}`;
      }
    };
    return [out('lfs', 'version'), out('lfs', 'ls-files', '-l'), out('status', '--short')].join('\n');
  };
  /** Fichiers d'un dossier (relatifs), ou « (absent) ». */
  const listFiles = (d: string) => {
    try {
      return (readdirSync(d, { recursive: true }) as string[]).sort().join('\n') || '(vide)';
    } catch {
      return '(absent)';
    }
  };
  /** Sortie complète (stdout + stderr, code) d'une commande git, sans lever d'erreur. */
  const capture = (env: Record<string, string>, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    return `$ git ${args.join(' ')} (code ${r.status})\n${r.stdout}${r.stderr}`;
  };
  /**
   * Diagnostic d'un `lfsPull` sans effet : la même commande `git lfs pull` relancée avec traces (stdout + stderr),
   * `git lfs env`, objets LFS du remote et locaux, état des fichiers.
   */
  const pullDiag = (paths: string[]) =>
    [
      capture({}, 'lfs', 'env'),
      `objets LFS du remote (${remote}) :\n${listFiles(join(remote, 'lfs', 'objects'))}`,
      `objets LFS locaux :\n${listFiles(join(dir, '.git', 'lfs', 'objects'))}`,
      lfsState(),
      ...lfsPullArgs(paths).map((a) => {
        const out = capture({}, '--literal-pathspecs', 'lfs', 'pull', ...a);
        const traced = capture({ GIT_TRACE: '1', GIT_TRANSFER_TRACE: '1' }, '--literal-pathspecs', 'lfs', 'pull', ...a);
        return `${out}\n--- avec traces (fin) ---\n${traced.slice(-8000)}`;
      }),
    ].join('\n\n');
  /** Vérifie le contenu d'un fichier après `lfsPull(paths)` ; en cas d'échec, message = diagnostic complet. */
  const expectPulled = (rel: string, expected: string, paths: string[]) => {
    const actual = readFileSync(join(dir, rel), 'utf8');
    if (actual !== expected) expect(actual, pullDiag(paths)).toBe(expected);
  };
  /** Pousse `main` et ses objets LFS vers le remote nu, puis vérifie que les objets y sont (pas de copie implicite). */
  const pushWithLfs = () => {
    run(dir, 'push', '-q', 'origin', 'main');
    run(dir, 'lfs', 'push', '--all', 'origin', 'main');
    const oids = run(dir, 'lfs', 'ls-files', '-l').split('\n').map((l) => l.split(' ')[0]);
    const onRemote = listFiles(join(remote, 'lfs', 'objects'));
    for (const oid of oids) expect(onRemote.includes(oid), `objet ${oid} absent du remote\n${onRemote}\n${capture({}, 'lfs', 'env')}`).toBe(true);
  };

  beforeAll(() => {
    // Diagnostic minimal : les sorties de git-lfs varient selon les versions.
    console.info(`git-lfs.test : ${run(tmpdir(), 'version')} ; ${run(tmpdir(), 'lfs', 'version')}`);
    root = mkdtempSync(join(tmpdir(), 'arbor-lfs-'));
    remote = join(root, 'distant.git');
    dir = join(root, 'dépôt lfs');
    mkdirSync(dir);
    run(root, 'init', '-q', '--bare', remote);
    run(dir, 'init', '-q', '-b', 'main');
    run(dir, 'config', 'user.name', 'Test');
    run(dir, 'config', 'user.email', 'test@example.com');
    run(dir, 'lfs', 'install', '--local');
    run(dir, 'lfs', 'track', '*.bin');
    mkdirSync(join(dir, 'données é'));
    writeFileSync(join(dir, 'données é', 'modèle 1.bin'), 'A'.repeat(20000));
    writeFileSync(join(dir, 'b.bin'), 'B'.repeat(300));
    writeFileSync(join(dir, 'lisez-moi.txt'), 'bonjour\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '-qm', 'init');
    run(dir, 'remote', 'add', 'origin', remote);
    pushWithLfs();
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => forgetLfsVersion());

  it('lfsInfo : version, motifs, fichiers du statut stockés dans LFS', async () => {
    writeFileSync(join(dir, 'nouveau.bin'), 'N');
    writeFileSync(join(dir, 'notes.txt'), 'n');
    try {
      const info = await lfsInfo(dir, ['nouveau.bin', 'notes.txt', 42]);
      expect(info.installed).toBe(true);
      expect(info.version).toMatch(/^\d+\.\d+/);
      expect(info.patterns).toEqual([{ pattern: '*.bin', source: '.gitattributes', excluded: false }]);
      expect(info.lfsPaths).toEqual(['nouveau.bin']);
    } finally {
      unlinkSync(join(dir, 'nouveau.bin'));
      unlinkSync(join(dir, 'notes.txt'));
    }
  });

  it('lfsInfo : aucun appel à git-lfs dans un dépôt sans LFS', async () => {
    const plain = join(root, 'simple');
    mkdirSync(plain);
    run(plain, 'init', '-q');
    const info = await lfsInfo(plain, ['a.bin']);
    expect(info.patterns).toEqual([]);
    expect(info.lfsPaths).toEqual([]);
    // `git lfs track` aurait créé <gitDir>/lfs et installé des hooks.
    expect(existsSync(join(plain, '.git', 'lfs'))).toBe(false);
    expect(readdirSync(join(plain, '.git', 'hooks')).filter((h) => !h.endsWith('.sample'))).toEqual([]);
  });

  it('lfsInfo : ouvrir un dépôt LFS sans hooks n\'en crée aucun et ne touche pas .git/config', async () => {
    const bare = join(root, 'sans-hooks');
    mkdirSync(bare);
    run(bare, 'init', '-q');
    writeFileSync(join(bare, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\nx.bin -filter\n');
    writeFileSync(join(bare, 'a.bin'), 'a');
    const config = readFileSync(join(bare, '.git', 'config'), 'utf8');
    const info = await lfsInfo(bare, ['a.bin', 'x.bin']);
    expect(info.patterns).toEqual([
      { pattern: '*.bin', source: '.gitattributes', excluded: false },
      { pattern: 'x.bin', source: '.gitattributes', excluded: true },
    ]);
    expect(info.lfsPaths).toEqual(['a.bin']);
    expect(readdirSync(join(bare, '.git', 'hooks')).filter((h) => !h.endsWith('.sample'))).toEqual([]);
    expect(readFileSync(join(bare, '.git', 'config'), 'utf8')).toBe(config);
    expect(existsSync(join(bare, '.git', 'lfs'))).toBe(false);
  });

  it('lfsFiles : chemins avec espaces et accents, taille, pointeur seul', async () => {
    const { files, truncated } = await lfsFiles(dir);
    expect(truncated).toBe(false);
    expect(files.map((f) => [f.path, f.present, f.size])).toEqual([
      ['b.bin', true, 300],
      ['données é/modèle 1.bin', true, 20000],
    ]);
  });

  it('diff : pointeurs comparés, carte LFS, pas d\'indexation partielle', async () => {
    const path = 'données é/modèle 1.bin';
    writeFileSync(join(dir, path), 'Z'.repeat(21504));
    try {
      const target = { kind: 'working' as const, path, staged: false };
      const raw = await diff(dir, target);
      const change = lfsPointerChange(raw);
      expect(change?.old?.size).toBe(20000);
      expect(change?.new?.size).toBe(21504);
      await expect(applyPatchSelection(dir, target, raw, [{ hunk: 0 }], 'stage')).rejects.toThrow(/Fichier LFS/);
    } finally {
      run(dir, 'checkout', '--', path);
    }
  });

  it('lfsTrack : suivre puis ne plus suivre (espaces), motifs refusés', async () => {
    await lfsTrack(dir, 'mes maquettes/*.psd', false);
    let patterns = (await lfsInfo(dir, [])).patterns.map((p) => p.pattern);
    expect(patterns).toContain('mes[[:space:]]maquettes/*.psd');
    await lfsTrack(dir, 'mes[[:space:]]maquettes/*.psd', true);
    patterns = (await lfsInfo(dir, [])).patterns.map((p) => p.pattern);
    expect(patterns).toEqual(['*.bin']);
    for (const bad of ['', '-x', '--json', 'a\nb', '#c', '!n']) await expect(lfsTrack(dir, bad, false)).rejects.toThrow();
    await expect(lfsTrack(dir, 'inconnu/*.iso', true)).rejects.toThrow(/n'est pas un motif suivi/);
    run(dir, 'checkout', '--', '.gitattributes');
  });

  it('lfsPull : récupère un pointeur seul, refuse motifs et chemins inconnus', async () => {
    const path = 'b.bin';
    const oid = run(dir, 'lfs', 'ls-files', '-l').split('\n').find((l) => l.endsWith(` ${path}`))!.split(' ')[0];
    rmSync(join(dir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid));
    writeFileSync(join(dir, path), run(dir, 'cat-file', 'blob', `HEAD:${path}`) + '\n');
    // Index rafraîchi (comme après un clone sans smudge) : sinon git-lfs récent voit un fichier modifié et ne l'écrase pas.
    run(dir, 'add', '--', path);
    expect((await lfsFiles(dir)).files.find((f) => f.path === path)?.present).toBe(false);
    await expect(lfsPull(dir, ['*.bin'])).rejects.toThrow(/motif/);
    await expect(lfsPull(dir, ['a,b.bin'])).rejects.toThrow(/motif/);
    await expect(lfsPull(dir, ['lisez-moi.txt'])).rejects.toThrow(/n'est pas un fichier LFS/);
    await expect(lfsPull(dir, [])).rejects.toThrow();
    await lfsPull(dir, [path]);
    expectPulled(path, 'B'.repeat(300), [path]);
    expect((await lfsFiles(dir)).files.find((f) => f.path === path)?.present, lfsState()).toBe(true);
  });

  it('sans git-lfs dans le PATH : statut relu sans filtre, motifs du .gitattributes, actions refusées', async () => {
    const bin = join(root, 'bin-sans-lfs');
    mkdirSync(bin);
    symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
    const path = 'données é/modèle 1.bin';
    // Même taille que la version indexée : Git doit comparer le contenu, donc passer par le filtre LFS (une taille
    // différente suffit à Git ≥ 2.5x pour conclure sans filtre, et `status` n'échouerait pas).
    writeFileSync(join(dir, path), 'Y'.repeat(20000));
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    forgetLfsVersion();
    try {
      // Précondition : git-lfs n'est plus trouvable (ni dans le PATH, ni dans `git --exec-path`).
      expect((await lfsInfo(dir, [])).installed, `git --exec-path : ${run(dir, '--exec-path')}`).toBe(false);
      const err = await status(dir).catch((e) => e);
      expect(isLfsMissing(err), `statut sans git-lfs : ${err instanceof Error ? (err as GitError).stderr : 'aucune erreur'}`).toBe(true);
      const snap = await snapshot(dir);
      expect(snap.status.unstaged.map((f) => f.path)).toContain(path);
      const info = await lfsInfo(dir, [path]);
      expect(info.installed).toBe(false);
      expect(info.patterns).toEqual([{ pattern: '*.bin', source: '.gitattributes', excluded: false }]);
      expect(info.lfsPaths).toEqual([path]);
      await expect(lfsFiles(dir)).rejects.toThrow(/git-lfs n'est pas installé/);
      await expect(lfsTrack(dir, '*.iso', false)).rejects.toThrow(/git-lfs n'est pas installé/);
    } finally {
      process.env.PATH = savedPath;
      forgetLfsVersion();
      run(dir, 'checkout', '--', path);
    }
  });

  it('diff : -U3 imposé malgré diff.context=0, la carte reste reconnue', async () => {
    const path = 'données é/modèle 1.bin';
    run(dir, 'config', 'diff.context', '0');
    writeFileSync(join(dir, path), 'W'.repeat(20000));
    try {
      const target = { kind: 'working' as const, path, staged: false };
      const raw = await diff(dir, target);
      expect(lfsPointerChange(raw)?.old?.size).toBe(20000);
      await expect(applyPatchSelection(dir, target, raw, [{ hunk: 0 }], 'stage')).rejects.toThrow(/Fichier LFS/);
    } finally {
      run(dir, 'config', '--unset', 'diff.context');
      run(dir, 'checkout', '--', path);
    }
  });

  it('indexation partielle refusée pour un fichier brut devenu pointeur (garde par attribut)', async () => {
    writeFileSync(join(dir, 'brut.dat'), 'ligne 1\nligne 2\n');
    run(dir, 'add', 'brut.dat');
    run(dir, 'commit', '-qm', 'brut');
    writeFileSync(join(dir, '.gitattributes'), `${readFileSync(join(dir, '.gitattributes'), 'utf8')}*.dat filter=lfs diff=lfs merge=lfs -text\n`);
    try {
      const target = { kind: 'working' as const, path: 'brut.dat', staged: false };
      const raw = await diff(dir, target);
      expect(raw).toContain('+version https://git-lfs.github.com/spec/v1');
      expect(lfsPointerChange(raw)).toBeNull(); // l'ancien côté n'est pas un pointeur
      await expect(applyPatchSelection(dir, target, raw, [{ hunk: 0 }], 'stage')).rejects.toThrow(/Fichier LFS/);
    } finally {
      run(dir, 'checkout', '--', '.gitattributes');
      run(dir, 'rm', '-q', 'brut.dat');
      run(dir, 'commit', '-qm', 'retire brut');
    }
  });

  it('lfsPull : seul le chemin demandé est récupéré, jamais un homonyme (racine ou sous-dossier)', async () => {
    mkdirSync(join(dir, 'a', 'sub'), { recursive: true });
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'x.bin'), 'racine');
    writeFileSync(join(dir, 'sub', 'x.bin'), 'sous-dossier');
    writeFileSync(join(dir, 'a', 'sub', 'x.bin'), 'profond');
    run(dir, 'add', 'x.bin', 'sub/x.bin', 'a/sub/x.bin');
    run(dir, 'commit', '-qm', 'trois x.bin');
    pushWithLfs();
    const lines = run(dir, 'lfs', 'ls-files', '-l').split('\n');
    for (const p of ['x.bin', 'sub/x.bin', 'a/sub/x.bin']) {
      const oid = lines.find((l) => l.endsWith(` ${p}`))!.split(' ')[0];
      rmSync(join(dir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid));
      writeFileSync(join(dir, p), run(dir, 'cat-file', 'blob', `HEAD:${p}`) + '\n');
    }
    run(dir, 'add', '--', 'x.bin', 'sub/x.bin', 'a/sub/x.bin'); // index rafraîchi : pointeurs non modifiés
    await lfsPull(dir, ['x.bin']);
    expectPulled('x.bin', 'racine', ['x.bin']);
    expect(readFileSync(join(dir, 'sub', 'x.bin'), 'utf8'), lfsState()).toMatch(/^version https:\/\/git-lfs/);
    const files = (await lfsFiles(dir)).files;
    expect(files.find((f) => f.path === 'x.bin')?.present, lfsState()).toBe(true);
    expect(files.find((f) => f.path === 'sub/x.bin')?.present, lfsState()).toBe(false);
    // Chemin avec dossier : `sub/x.bin` est récupéré, pas `a/sub/x.bin`.
    await lfsPull(dir, ['sub/x.bin']);
    expectPulled('sub/x.bin', 'sous-dossier', ['sub/x.bin']);
    expect(readFileSync(join(dir, 'a', 'sub', 'x.bin'), 'utf8'), lfsState()).toMatch(/^version https:\/\/git-lfs/);
  });
});
