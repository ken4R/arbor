import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { lfsPointerChange } from '../shared/lfs';
import {
  applyPatchSelection,
  diff,
  forgetLfsVersion,
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
      "error: external filter 'git-lfs filter-process' failed",
      "git: 'lfs' is not a git command. See 'git --help'.",
    ])
      expect(translateGitError(raw)).toMatch(/^git-lfs n'est pas installé/);
  });
});

describe.skipIf(!lfsInstalled)('LFS (git-lfs installé)', () => {
  let root: string;
  let dir: string;
  let remote: string;

  beforeAll(() => {
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
    run(dir, 'push', '-q', 'origin', 'main');
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
    // `git lfs track` aurait créé <gitDir>/lfs.
    expect(() => readFileSync(join(plain, '.git', 'lfs'))).toThrow();
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
    expect((await lfsFiles(dir)).files.find((f) => f.path === path)?.present).toBe(false);
    await expect(lfsPull(dir, ['*.bin'])).rejects.toThrow(/motif/);
    await expect(lfsPull(dir, ['a,b.bin'])).rejects.toThrow(/motif/);
    await expect(lfsPull(dir, ['lisez-moi.txt'])).rejects.toThrow(/n'est pas un fichier LFS/);
    await expect(lfsPull(dir, [])).rejects.toThrow();
    await lfsPull(dir, [path]);
    expect((await lfsFiles(dir)).files.find((f) => f.path === path)?.present).toBe(true);
    expect(readFileSync(join(dir, path), 'utf8')).toBe('B'.repeat(300));
  });

  it('sans git-lfs dans le PATH : statut relu sans filtre, motifs du .gitattributes, actions refusées', async () => {
    const bin = join(root, 'bin-sans-lfs');
    mkdirSync(bin);
    symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
    const path = 'données é/modèle 1.bin';
    writeFileSync(join(dir, path), 'Y'.repeat(100));
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    forgetLfsVersion();
    try {
      const err = await status(dir).catch((e) => e);
      expect(isLfsMissing(err)).toBe(true);
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
});
