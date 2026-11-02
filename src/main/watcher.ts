// Surveillance du dépôt ouvert : prévient le rendu quand le dépôt change hors d'Arbor (terminal, éditeur…).
// Pas d'import d'electron ici : l'envoi au rendu est fourni par main.ts, ce qui garde ce module testable.
import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoChangeEvent } from '../shared/types';
import { gitDirs, ignoredPaths } from './git';

export type WatchScope = RepoChangeEvent['scope'];

/** Fichiers du dossier Git dont la modification change ce qu'affiche Arbor. */
const GIT_FILES = new Set(['HEAD', 'index', 'packed-refs', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']);
/** Dossiers du dossier Git dont tout le contenu compte. */
const GIT_TREES = new Set(['refs', 'rebase-merge', 'rebase-apply']);

/**
 * Classe un chemin signalé par la surveillance.
 * `base` = 'worktree' : chemin relatif à la racine de l'arbre de travail (`.git/…` est traité comme le dossier Git) ;
 * `base` = 'gitdir' : chemin relatif au dossier Git.
 * Renvoie `null` pour ce qui ne change rien à l'affichage (objets, journaux, verrous, hooks, FETCH_HEAD, ORIG_HEAD…).
 */
export function classifyWatchPath(rel: string, base: 'worktree' | 'gitdir' = 'worktree'): WatchScope | null {
  const p = rel.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!p) return null;
  if (base === 'worktree') {
    if (p === '.git') return null;
    if (p.startsWith('.git/')) return classifyWatchPath(p.slice(5), 'gitdir');
    // Dossier Git d'un sous-module ou d'un dépôt imbriqué : hors périmètre.
    if (/\/\.git(?:\/|$)/.test(p)) return null;
    return 'worktree';
  }
  if (p.endsWith('.lock')) return null;
  if (GIT_FILES.has(p)) return 'git';
  return GIT_TREES.has(p.split('/')[0]) ? 'git' : null;
}

/**
 * Regroupe les événements : envoi 300 ms après le dernier, au plus 2 s après le premier d'une rafale.
 * Les portées sont fusionnées (`git` l'emporte, car il rafraîchit tout). Pour `worktree`, les chemins sont
 * transmis afin d'écarter ceux que Git ignore ; `null` = liste inconnue ou trop longue, à ne pas filtrer.
 */
export class ChangeDebouncer {
  private scope: WatchScope | null = null;
  private paths: Set<string> | null = new Set();
  private first = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onFlush: (scope: WatchScope, paths: string[] | null) => void,
    private readonly quietMs = 300,
    private readonly maxWaitMs = 2000,
    private readonly maxPaths = 500,
  ) {}

  push(scope: WatchScope, path?: string): void {
    const now = Date.now();
    if (this.scope === null) this.first = now;
    if (scope === 'git') this.scope = 'git';
    else if (this.scope === null) this.scope = 'worktree';
    if (scope === 'worktree' && this.paths) {
      if (path === undefined || this.paths.size >= this.maxPaths) this.paths = null;
      else this.paths.add(path);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), Math.max(0, Math.min(this.quietMs, this.first + this.maxWaitMs - now)));
  }

  flush(): void {
    const { scope, paths } = this;
    this.cancel();
    if (scope) this.onFlush(scope, scope === 'git' || !paths ? null : [...paths]);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.scope = null;
    this.paths = new Set();
  }
}

/**
 * Sourdine : les événements reçus pendant une commande d'Arbor, et pendant `graceMs` après la dernière,
 * viennent d'Arbor lui-même et sont jetés. Un compteur gère les commandes concurrentes ou imbriquées.
 */
export class Muter {
  private active = 0;
  private until = 0;

  constructor(private readonly graceMs = 400) {}

  get muted(): boolean {
    return this.active > 0 || Date.now() < this.until;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.until = Math.max(this.until, Date.now() + this.graceMs);
    }
  }
}

const isWatchLimit = (e: unknown) => ['ENOSPC', 'EMFILE'].includes((e as NodeJS.ErrnoException)?.code ?? '');

/** Une surveillance en cours ; `onRel` reçoit le chemin relatif à la racine surveillée (`null` si inconnu). */
interface TreeHandle {
  close(): void;
}

interface TreeOptions {
  /** Garde, parmi des sous-dossiers (chemins relatifs), ceux à surveiller. */
  keepDirs: (rels: string[]) => Promise<string[]>;
  onRel: (rel: string | null) => void;
  /** Limite de surveillance atteinte (ENOSPC/EMFILE). */
  onLimit: (e: unknown) => void;
}

/**
 * Surveillance récursive avec un `fs.watch` par dossier, utilisée sous Linux : le mode `recursive` de Node 20
 * y surveille chaque fichier par son inode et perd ceux que Git remplace par renommage (`index`, `refs/heads/…`),
 * si bien que seul le premier commit fait hors d'Arbor était vu. Un dossier signale, lui, chaque renommage.
 */
class DirTreeWatcher implements TreeHandle {
  private readonly dirs = new Map<string, FSWatcher>();
  private closed = false;

  constructor(private readonly root: string, private readonly opts: TreeOptions) {
    void this.addTree(['']);
  }

  close(): void {
    this.closed = true;
    for (const w of this.dirs.values()) w.close();
    this.dirs.clear();
  }

  private async addTree(start: string[]) {
    let level = start;
    while (level.length && !this.closed) {
      const next: string[] = [];
      for (const rel of level) {
        if (this.closed || this.dirs.has(rel)) continue;
        if (!this.watchDir(rel)) return;
        try {
          for (const e of await readdir(join(this.root, rel), { withFileTypes: true })) {
            if (e.isDirectory()) next.push(rel ? `${rel}/${e.name}` : e.name);
          }
        } catch {
          /* dossier disparu entre-temps */
        }
      }
      level = next.length && !this.closed ? await this.opts.keepDirs(next) : [];
    }
  }

  private watchDir(rel: string): boolean {
    try {
      const w = watch(join(this.root, rel), { persistent: false }, (_type, name) => {
        if (this.closed) return;
        const child = name == null ? null : rel ? `${rel}/${name}` : String(name);
        this.opts.onRel(child);
        if (child) void this.checkChild(child);
      });
      w.on('error', (e) => {
        this.removeDir(rel);
        if (isWatchLimit(e)) this.opts.onLimit(e);
      });
      this.dirs.set(rel, w);
      return true;
    } catch (e) {
      if (!isWatchLimit(e)) return true; // dossier disparu : on continue avec les autres
      this.opts.onLimit(e);
      return false;
    }
  }

  /** Un nom a changé dans un dossier surveillé : nouveau sous-dossier à suivre, ou dossier supprimé à oublier. */
  private async checkChild(rel: string) {
    let isDir = false;
    try {
      isDir = (await stat(join(this.root, rel))).isDirectory();
    } catch {
      /* supprimé */
    }
    if (this.closed) return;
    if (!isDir) return this.removeDir(rel);
    if (this.dirs.has(rel)) return;
    const keep = await this.opts.keepDirs([rel]);
    if (keep.length) await this.addTree(keep);
  }

  private removeDir(rel: string) {
    for (const [r, w] of this.dirs) {
      if (r === rel || r.startsWith(`${rel}/`)) {
        w.close();
        this.dirs.delete(r);
      }
    }
  }
}

/** Ailleurs (macOS, Windows), la surveillance récursive native du système suffit. */
function nativeTree(root: string, opts: TreeOptions): TreeHandle {
  try {
    const w = watch(root, { recursive: true, persistent: false }, (_type, name) => opts.onRel(name == null ? null : String(name)));
    w.on('error', (e) => {
      w.close();
      opts.onLimit(e);
    });
    return w;
  } catch (e) {
    opts.onLimit(e);
    return { close() {} };
  }
}

const watchTree = (root: string, opts: TreeOptions): TreeHandle =>
  process.platform === 'linux' ? new DirTreeWatcher(root, opts) : nativeTree(root, opts);

/** Dossiers du dossier Git à parcourir : les références et les opérations en cours, pas les objets ni les journaux. */
const gitDirsToWatch = async (rels: string[]) => rels.filter((r) => GIT_TREES.has(r.split('/')[0]));

export class RepoWatcher {
  private handles: TreeHandle[] = [];
  private worktree: TreeHandle | null = null;
  private repo: string | null = null;
  private generation = 0;
  private warned = false;
  private readonly muter = new Muter();
  private readonly debouncer = new ChangeDebouncer((scope, paths) => void this.emit(scope, paths));

  constructor(private readonly send: (ev: RepoChangeEvent) => void) {}

  /** Exécute une commande d'Arbor sans que ses propres écritures déclenchent un rafraîchissement. */
  mute<T>(fn: () => Promise<T>): Promise<T> {
    return this.muter.run(fn);
  }

  async watch(repo: string): Promise<void> {
    if (this.repo === repo && this.handles.length) return;
    this.stop();
    const gen = this.generation;
    const { gitDir, commonDir } = await gitDirs(repo);
    if (gen !== this.generation) return; // `stop` ou un autre `watch` est passé entre-temps.
    this.repo = repo;
    const ignoreLimit = () => {
      /* dossier Git : on garde ce qui a pu être surveillé ; le rafraîchissement au focus reste le filet */
    };
    this.handles.push(
      watchTree(gitDir, { keepDirs: gitDirsToWatch, onLimit: ignoreLimit, onRel: (rel) => this.onGitPath(rel, false) }),
    );
    // Worktree lié : seules les références du dossier commun le concernent (HEAD et index sont les siens).
    if (commonDir !== gitDir) {
      this.handles.push(
        watchTree(commonDir, { keepDirs: gitDirsToWatch, onLimit: ignoreLimit, onRel: (rel) => this.onGitPath(rel, true) }),
      );
    }
    const worktree = watchTree(repo, {
      // Ni les dossiers `.git` (surveillés à part, ou sous-modules), ni les dossiers que Git ignore (node_modules…).
      keepDirs: async (rels) => {
        const candidates = rels.filter((r) => !/(?:^|\/)\.git$/.test(r));
        try {
          const ignored = await ignoredPaths(repo, candidates);
          return candidates.filter((r) => !ignored.has(r));
        } catch {
          return candidates;
        }
      },
      onLimit: (e) => {
        worktree.close();
        this.handles = this.handles.filter((h) => h !== worktree);
        this.warnFallback(e);
      },
      onRel: (rel) => {
        if (this.muter.muted) return;
        if (rel === null) return this.debouncer.push('worktree');
        const p = rel.replace(/\\/g, '/');
        const scope = classifyWatchPath(p, 'worktree');
        if (scope) this.debouncer.push(scope, scope === 'worktree' ? p : undefined);
      },
    });
    this.worktree = worktree;
    this.handles.push(worktree);
  }

  stop(): void {
    this.generation++;
    for (const h of this.handles) h.close();
    this.handles = [];
    this.worktree = null;
    this.repo = null;
    this.debouncer.cancel();
  }

  private onGitPath(rel: string | null, shared: boolean) {
    if (this.muter.muted || rel === null) return;
    const p = rel.replace(/\\/g, '/');
    if (shared && p !== 'packed-refs' && !p.startsWith('refs/')) return;
    if (classifyWatchPath(p, 'gitdir')) this.debouncer.push('git');
  }

  /** Trop de fichiers à surveiller : on garde le dossier Git seul, et on le dit une fois. */
  private warnFallback(e: unknown) {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      isWatchLimit(e)
        ? "Arbor : limite de surveillance de fichiers atteinte, seul le dossier Git est surveillé (les modifications de fichiers apparaîtront au retour dans la fenêtre)."
        : `Arbor : surveillance de l'arbre de travail impossible (${(e as Error)?.message ?? e}), seul le dossier Git est surveillé.`,
    );
  }

  private async emit(scope: WatchScope, paths: string[] | null) {
    const repo = this.repo;
    if (!repo) return;
    if (scope === 'worktree' && paths) {
      try {
        const ignored = await ignoredPaths(repo, paths);
        if (paths.every((p) => ignored.has(p))) return;
      } catch {
        /* en cas de doute (sous-module…), on rafraîchit */
      }
    }
    if (repo === this.repo) this.send({ repo, scope });
  }
}
