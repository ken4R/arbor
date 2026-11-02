import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeDebouncer, Muter, classifyWatchPath } from './watcher';
import { unquoteGitPath } from './git';

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
