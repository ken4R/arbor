import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeDebouncer, DirTreeWatcher, Muter, WatchCapError, classifyWatchPath } from './watcher';
import { ignoredPaths, unquoteGitPath } from './git';

describe('unquoteGitPath (sortie de git check-ignore)', () => {
  it('laisse les chemins ordinaires tels quels, accents compris (core.quotePath=false)', () => {
    expect(unquoteGitPath('build/sortie.txt')).toBe('build/sortie.txt');
    expect(unquoteGitPath('nouveau é.tmp')).toBe('nouveau é.tmp');
    expect(unquoteGitPath('"')).toBe('"');
  });
  it('décode les guillemets, barres obliques inverses, tabulations et octets en octal', () => {
    expect(unquoteGitPath('"dir é/a\\"b.tmp"')).toBe('dir é/a"b.tmp');
    expect(unquoteGitPath('"a\\\\b\\tc\\nd"')).toBe('a\\b\tc\nd');
    expect(unquoteGitPath('"\\303\\251cran.txt"')).toBe('écran.txt');
  });
});

describe('classifyWatchPath', () => {
  it('classe les fichiers du dossier Git qui changent l’affichage', () => {
    for (const p of ['HEAD', 'index', 'packed-refs', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      expect(classifyWatchPath(p, 'gitdir')).toBe('git');
    }
    expect(classifyWatchPath('refs/heads/main', 'gitdir')).toBe('git');
    expect(classifyWatchPath('refs/heads/fonctionnalité/écran de connexion', 'gitdir')).toBe('git');
    expect(classifyWatchPath('refs/remotes/origin/main', 'gitdir')).toBe('git');
    expect(classifyWatchPath('refs/stash', 'gitdir')).toBe('git');
    expect(classifyWatchPath('refs', 'gitdir')).toBe('git');
    expect(classifyWatchPath('rebase-merge/done', 'gitdir')).toBe('git');
    expect(classifyWatchPath('rebase-apply', 'gitdir')).toBe('git');
  });

  it('ignore objets, journaux, verrous, hooks, FETCH_HEAD et ORIG_HEAD', () => {
    for (const p of [
      'objects/ab/cdef0123',
      'objects/pack/pack-1.pack',
      'logs/HEAD',
      'logs/refs/heads/main',
      'index.lock',
      'HEAD.lock',
      'refs/heads/main.lock',
      'packed-refs.lock',
      'hooks/pre-commit',
      'FETCH_HEAD',
      'ORIG_HEAD',
      'COMMIT_EDITMSG',
      'config',
      '',
    ]) {
      expect(classifyWatchPath(p, 'gitdir'), p).toBeNull();
    }
  });

  it('traite `.git/` vu depuis l’arbre de travail comme le dossier Git', () => {
    expect(classifyWatchPath('.git/HEAD')).toBe('git');
    expect(classifyWatchPath('.git/refs/heads/main')).toBe('git');
    expect(classifyWatchPath('.git/index.lock')).toBeNull();
    expect(classifyWatchPath('.git/objects/12/3456')).toBeNull();
    expect(classifyWatchPath('.git')).toBeNull();
  });

  it('classe le reste de l’arbre de travail en `worktree`', () => {
    expect(classifyWatchPath('README.md')).toBe('worktree');
    expect(classifyWatchPath('src/écran de connexion.ts')).toBe('worktree');
    expect(classifyWatchPath('.gitignore')).toBe('worktree');
    expect(classifyWatchPath('.github/workflows/ci.yml')).toBe('worktree');
    // `*.lock` ne compte que dans le dossier Git.
    expect(classifyWatchPath('yarn.lock')).toBe('worktree');
    // Chemins Windows.
    expect(classifyWatchPath('src\\app.ts')).toBe('worktree');
    expect(classifyWatchPath('.git\\refs\\heads\\main')).toBe('git');
  });

  it('ignore l’intérieur du dossier Git d’un sous-module', () => {
    expect(classifyWatchPath('vendor/lib/.git/HEAD')).toBeNull();
    expect(classifyWatchPath('vendor/lib/.git')).toBeNull();
    expect(classifyWatchPath('vendor/lib/src/a.c')).toBe('worktree');
  });
});

describe('ChangeDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('envoie une seule fois 300 ms après le dernier événement', () => {
    const flush = vi.fn();
    const d = new ChangeDebouncer(flush);
    d.push('worktree', 'a.txt');
    vi.advanceTimersByTime(200);
    d.push('worktree', 'b.txt');
    vi.advanceTimersByTime(299);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('worktree', ['a.txt', 'b.txt']);
    vi.advanceTimersByTime(5000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('envoie au plus 2 s après le début d’une rafale continue', () => {
    const flush = vi.fn();
    const d = new ChangeDebouncer(flush);
    for (let t = 0; t < 1900; t += 100) {
      d.push('worktree', `f${t}`);
      vi.advanceTimersByTime(100);
    }
    expect(flush).not.toHaveBeenCalled();
    d.push('worktree', 'dernier');
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
    // La rafale continue : une nouvelle fenêtre commence.
    d.push('worktree', 'suite');
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith('worktree', ['suite']);
  });

  it('fusionne les portées : `git` l’emporte et rend la liste inutile', () => {
    const flush = vi.fn();
    const d = new ChangeDebouncer(flush);
    d.push('worktree', 'a.txt');
    d.push('git');
    d.push('worktree', 'b.txt');
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenCalledWith('git', null);
  });

  it('renonce au filtrage quand la liste est trop longue ou inconnue', () => {
    const flush = vi.fn();
    const d = new ChangeDebouncer(flush, 300, 2000, 3);
    for (const p of ['a', 'b', 'c', 'd']) d.push('worktree', p);
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenLastCalledWith('worktree', null);
    d.push('worktree', 'a');
    d.push('worktree');
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenLastCalledWith('worktree', null);
  });

  it('cancel oublie les événements en attente', () => {
    const flush = vi.fn();
    const d = new ChangeDebouncer(flush);
    d.push('git');
    d.cancel();
    vi.advanceTimersByTime(3000);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('Muter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('est en sourdine pendant la commande puis pendant 400 ms', async () => {
    const m = new Muter();
    expect(m.muted).toBe(false);
    const job = deferred();
    const run = m.run(() => job.promise);
    expect(m.muted).toBe(true);
    job.resolve();
    await run;
    expect(m.muted).toBe(true);
    vi.advanceTimersByTime(399);
    expect(m.muted).toBe(true);
    vi.advanceTimersByTime(1);
    expect(m.muted).toBe(false);
  });

  it('reste en sourdine tant qu’une commande concurrente tourne', async () => {
    const m = new Muter();
    const a = deferred();
    const b = deferred();
    const ra = m.run(() => a.promise);
    const rb = m.run(() => b.promise);
    a.resolve();
    await ra;
    vi.advanceTimersByTime(1000);
    expect(m.muted).toBe(true);
    b.resolve();
    await rb;
    vi.advanceTimersByTime(399);
    expect(m.muted).toBe(true);
    vi.advanceTimersByTime(1);
    expect(m.muted).toBe(false);
  });

  it('gère l’imbrication et les erreurs', async () => {
    const m = new Muter();
    const value = await m.run(() => m.run(async () => 42));
    expect(value).toBe(42);
    await expect(m.run(async () => Promise.reject(new Error('échec')))).rejects.toThrow('échec');
    expect(m.muted).toBe(true);
    vi.advanceTimersByTime(400);
    expect(m.muted).toBe(false);
  });
});

// Intégration : vrai dépôt temporaire, vrai `git`, vrai `fs.watch`.
describe('intégration avec un dépôt temporaire', () => {
  let root = '';
  let repo = '';
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'arbor-watch-'));
    const sub = join(root, 'sub-src');
    repo = join(root, 'repo');
    for (const dir of [sub, repo]) {
      mkdirSync(dir);
      sh(dir, 'init', '-q', '-b', 'main');
      sh(dir, 'config', 'user.name', 'Test');
      sh(dir, 'config', 'user.email', 'test@example.com');
    }
    writeFileSync(join(sub, 'inner.txt'), 'x');
    sh(sub, 'add', '-A');
    sh(sub, 'commit', '-qm', 'init');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n:x\n');
    writeFileSync(join(repo, 'a.txt'), 'a');
    mkdirSync(join(repo, 'node_modules/pkg/deep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules/pkg/a.js'), 'x');
    mkdirSync(join(repo, 'src/lib'), { recursive: true });
    writeFileSync(join(repo, 'src/lib/b.ts'), 'b');
    writeFileSync(join(repo, ':x'), 'x');
    sh(repo, 'add', '-A');
    sh(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
    sh(repo, 'commit', '-qm', 'init');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('ignoredPaths : sous-module, nom en `:x` et dossier ignoré', async () => {
    const paths = ['a.txt', 'node_modules', 'node_modules/pkg/a.js', ':x', 'sub/inner.txt', 'src/lib/b.ts'];
    const ignored = await ignoredPaths(repo, paths);
    expect(ignored.has('node_modules')).toBe(true);
    expect(ignored.has('node_modules/pkg/a.js')).toBe(true);
    expect(ignored.has(':x')).toBe(true);
    // Git refuse de vérifier l'intérieur d'un sous-module : compté comme ignoré, sans rendre le reste du lot « non ignoré ».
    expect(ignored.has('sub/inner.txt')).toBe(true);
    expect(ignored.has('a.txt')).toBe(false);
    expect(ignored.has('src/lib/b.ts')).toBe(false);
  });

  const keepDirsSpy = () => {
    const calls: string[][] = [];
    let live = 0;
    let maxLive = 0;
    const keepDirs = async (rels: string[]) => {
      calls.push(rels);
      maxLive = Math.max(maxLive, ++live);
      try {
        const ignored = await ignoredPaths(repo, rels);
        return rels.filter((r) => r !== '.git' && !ignored.has(r));
      } finally {
        live--;
      }
    };
    return { calls, keepDirs, maxLive: () => maxLive };
  };

  it('ne parcourt ni les dossiers ignorés ni les sous-modules, et regroupe les nouveaux dossiers', async () => {
    const spy = keepDirsSpy();
    const onLimit = vi.fn();
    const w = new DirTreeWatcher(repo, { keepDirs: spy.keepDirs, onRel: () => {}, onLimit });
    try {
      await w.idle();
      expect(w.watched().sort()).toEqual(['', 'src', 'src/lib']);

      spy.calls.length = 0;
      for (let i = 0; i < 300; i++) mkdirSync(join(repo, `m${i}/x`), { recursive: true });
      await sleep(300);
      await w.idle();
      expect(w.size).toBe(3 + 600);
      expect(spy.maxLive()).toBe(1);
      expect(spy.calls.every((c) => c.length <= 50)).toBe(true);
      expect(spy.calls.length).toBeLessThan(40);
      expect(onLimit).not.toHaveBeenCalled();

      // Dossier supprimé : oublié, lui et ses sous-dossiers.
      rmSync(join(repo, 'm0'), { recursive: true });
      await sleep(300);
      expect(w.watched().some((d) => d === 'm0' || d.startsWith('m0/'))).toBe(false);
    } finally {
      w.close();
      for (let i = 0; i < 300; i++) rmSync(join(repo, `m${i}`), { recursive: true, force: true });
    }
  });

  it('se replie au-delà du plafond de dossiers', async () => {
    const onLimit = vi.fn();
    const w = new DirTreeWatcher(repo, { keepDirs: keepDirsSpy().keepDirs, onRel: () => {}, onLimit, maxDirs: 2 });
    try {
      await w.idle();
      expect(onLimit).toHaveBeenCalledTimes(1);
      expect(onLimit.mock.calls[0][0]).toBeInstanceOf(WatchCapError);
    } finally {
      w.close();
    }
  });
});
