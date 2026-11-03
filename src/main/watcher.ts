// Surveillance du dépôt ouvert : prévient le rendu quand le dépôt change hors d'Arbor (terminal, éditeur…).
// Pas d'import d'electron ici : l'envoi au rendu est fourni par main.ts, ce qui garde ce module testable.
import { existsSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RepoChangeEvent, WatchLimitedEvent } from '../shared/types';
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

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? '';
const isWatchLimit = (e: unknown) => ['ENOSPC', 'EMFILE', 'ENFILE'].includes(errCode(e));
const isGone = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes(errCode(e));

/** Plafond de dossiers surveillés un par un ; au-delà, on se replie sur le dossier Git seul. */
export const MAX_WATCHED_DIRS = Number(process.env.ARBOR_MAX_WATCHED_DIRS) || 10_000; // variable : pour les tests

/** Erreur signalée quand le plafond de dossiers est atteint. */
export class WatchCapError extends Error {
  readonly code = 'ECAP';
}

/** Une surveillance en cours. */
interface TreeHandle {
  close(): void;
}

export interface TreeOptions {
  /** Garde, parmi des sous-dossiers (chemins relatifs, au plus 50 à la fois), ceux à surveiller. */
  keepDirs: (rels: string[]) => Promise<string[]>;
  /** Chemin relatif à la racine surveillée qui a changé (`null` si inconnu). */
  onRel: (rel: string | null) => void;
  /** Limite de surveillance atteinte (ENOSPC/EMFILE/ENFILE ou plafond `WatchCapError`). */
  onLimit: (e: unknown) => void;
  /** Plafond de dossiers (défaut : `MAX_WATCHED_DIRS`). */
  maxDirs?: number;
  /** Délai de regroupement des nouveaux dossiers (défaut : 50 ms). */
  batchMs?: number;
}

/**
 * Surveillance récursive avec un `fs.watch` par dossier, utilisée sous Linux : le mode `recursive` de Node 20
 * y surveille chaque fichier par son inode et perd ceux que Git remplace par renommage (`index`, `refs/heads/…`),
 * si bien que seul le premier commit fait hors d'Arbor était vu. Un dossier signale, lui, chaque renommage.
 *
 * Les nouveaux dossiers sont regroupés (file d'attente + minuterie) et parcourus un lot à la fois, avec un seul
 * `keepDirs` par lot de 50 : un checkout qui crée des milliers de dossiers ne lance pas des milliers de `git`.
 * Un dossier qui contient une entrée `.git` (sous-module, dépôt imbriqué) n'est pas parcouru.
 */
export class DirTreeWatcher implements TreeHandle {
  private readonly dirs = new Map<string, FSWatcher>();
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly maxDirs: number;
  private readonly batchMs: number;

  constructor(private readonly root: string, private readonly opts: TreeOptions) {
    this.maxDirs = opts.maxDirs ?? MAX_WATCHED_DIRS;
    this.batchMs = opts.batchMs ?? 50;
    this.enqueueWalk(['']);
  }

  /** Nombre de dossiers surveillés. */
  get size(): number {
    return this.dirs.size;
  }

  /** Dossiers surveillés (chemins relatifs, '' = racine). */
  watched(): string[] {
    return [...this.dirs.keys()];
  }

  /** Se résout quand les parcours en attente sont terminés (pour les tests). */
  async idle(): Promise<void> {
    while (this.timer || this.pending.size) await new Promise((r) => setTimeout(r, this.batchMs));
    await this.chain;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.timer = this.sweepTimer = null;
    this.pending.clear();
    for (const w of this.dirs.values()) w.close();
    this.dirs.clear();
  }

  /** Un seul parcours à la fois. */
  private enqueueWalk(start: string[]) {
    this.chain = this.chain.then(() => this.walk(start)).catch(() => {});
  }

  private async walk(start: string[]) {
    let level = start;
    while (level.length && !this.closed) {
      const next: string[] = [];
      for (const rel of level) {
        if (this.closed) return;
        if (this.dirs.has(rel)) continue;
        let entries: Dirent[];
        try {
          entries = await readdir(join(this.root, rel), { withFileTypes: true });
        } catch (e) {
          if (isGone(e)) continue; // disparu entre-temps
          if (isWatchLimit(e)) return this.limit(e);
          continue; // illisible (droits…) : pas surveillé
        }
        // Sous-module ou dépôt imbriqué : on surveille son nom depuis le parent, pas son contenu.
        if (rel && entries.some((e) => e.name === '.git')) continue;
        if (this.dirs.size >= this.maxDirs) return this.limit(new WatchCapError(`plus de ${this.maxDirs} dossiers`));
        if (!this.watchDir(rel)) return;
        for (const e of entries) if (e.isDirectory()) next.push(rel ? `${rel}/${e.name}` : e.name);
      }
      level = [];
      for (let i = 0; i < next.length && !this.closed; i += 50) {
        level.push(...(await this.opts.keepDirs(next.slice(i, i + 50))));
      }
    }
  }

  private limit(e: unknown) {
    if (this.closed) return;
    this.opts.onLimit(e);
  }

  private watchDir(rel: string): boolean {
    const abs = join(this.root, rel);
    try {
      const w = watch(abs, { persistent: false }, (_type, name) => {
        if (this.closed) return;
        if (name == null) return this.opts.onRel(null);
        const n = String(name);
        // Le dossier surveillé lui-même a été supprimé : inotify le signale sous son propre nom.
        if (rel && n === basename(rel) && !existsSync(abs)) {
          this.removeDir(rel);
          return this.scheduleSweep();
        }
        const child = rel ? `${rel}/${n}` : n;
        this.opts.onRel(child);
        void this.checkChild(child);
      });
      w.on('error', (e) => {
        this.removeDir(rel);
        if (isWatchLimit(e)) this.limit(e);
      });
      this.dirs.set(rel, w);
      return true;
    } catch (e) {
      if (!isWatchLimit(e)) return true; // dossier disparu : on continue avec les autres
      this.limit(e);
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
    if (!isDir) {
      this.removeDir(rel);
      return this.scheduleSweep();
    }
    if (this.dirs.has(rel)) return;
    this.pending.add(rel);
    this.timer ??= setTimeout(() => this.flushPending(), this.batchMs);
  }

  private flushPending() {
    this.timer = null;
    const rels = [...this.pending].filter((r) => !this.dirs.has(r));
    this.pending.clear();
    if (!rels.length || this.closed) return;
    this.chain = this.chain
      .then(async () => {
        const keep: string[] = [];
        for (let i = 0; i < rels.length && !this.closed; i += 50) keep.push(...(await this.opts.keepDirs(rels.slice(i, i + 50))));
        if (keep.length) await this.walk(keep);
      })
      .catch(() => {});
  }

  /**
   * Toutes les surveillances partagent une file inotify, qui peut déborder lors d'une suppression massive
   * (checkout) : des événements sont alors perdus. Après une suppression, on vérifie donc que chaque dossier
   * surveillé existe encore (500 ms après la dernière).
   */
  private scheduleSweep() {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      if (this.closed) return;
      for (const rel of [...this.dirs.keys()]) if (rel && !existsSync(join(this.root, rel))) this.removeDir(rel);
    }, 500);
  }

  private removeDir(rel: string) {
    if (!this.dirs.has(rel)) return;
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

export const WATCH_LIMITED_MESSAGE =
  "Trop de fichiers à surveiller : seul le dossier Git est suivi. Les modifications de fichiers apparaîtront au retour dans la fenêtre ou avec « Rafraîchir ».";

export class RepoWatcher {
  private handles: TreeHandle[] = [];
  private worktree: TreeHandle | null = null;
  private repo: string | null = null;
  private generation = 0;
  private warnedRepo: string | null = null;
  private readonly muter = new Muter();
  private readonly debouncer = new ChangeDebouncer((scope, paths) => void this.emit(scope, paths));

  /**
   * `send` : changement à signaler au rendu ; `notify` : surveillance réduite (message à afficher une fois par dépôt).
   */
  constructor(
    private readonly send: (ev: RepoChangeEvent) => void,
    private readonly notify: (ev: WatchLimitedEvent) => void = () => {},
  ) {}

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
      // Ni les dossiers `.git` (surveillés à part), ni les dossiers que Git ignore (node_modules…).
      keepDirs: async (rels) => {
        const candidates = rels.filter((r) => !/(?:^|\/)\.git$/.test(r));
        const ignored = await ignoredPaths(repo, candidates);
        return candidates.filter((r) => !ignored.has(r));
      },
      onLimit: (e) => {
        if (this.worktree !== worktree) return;
        worktree.close();
        this.worktree = null;
        this.handles = this.handles.filter((h) => h !== worktree);
        this.warnLimited(repo, e);
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

  /** Surveillance réduite au dossier Git : on prévient une fois par dépôt (console et interface). */
  private warnLimited(repo: string, e: unknown) {
    if (this.warnedRepo === repo) return;
    this.warnedRepo = repo;
    console.warn(`Arbor : surveillance de l'arbre de travail réduite (${errCode(e) || (e as Error)?.message || e}).`);
    this.notify({ repo, message: WATCH_LIMITED_MESSAGE });
  }

  private async emit(scope: WatchScope, paths: string[] | null) {
    const repo = this.repo;
    if (!repo) return;
    if (scope === 'worktree' && paths) {
      const ignored = await ignoredPaths(repo, paths);
      if (paths.every((p) => ignored.has(p))) return;
    }
    if (repo === this.repo) this.send({ repo, scope });
  }
}
