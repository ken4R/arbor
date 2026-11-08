import type { Preferences } from './prefs';

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  date: number; // secondes epoch
  subject: string;
  body: string;
  refs: Ref[];
}

export interface Ref {
  name: string;
  type: 'head' | 'local' | 'remote' | 'tag';
}

/** Résultat d'une recherche de commits par chemin de fichier modifié. */
export interface FileSearchResult {
  shas: string[];
  truncated: boolean; // limite de résultats atteinte
}

export type FileStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | 'T';

export interface FileChange {
  path: string;
  oldPath?: string;
  status: FileStatusCode;
}

export interface WorkingStatus {
  branch: string | null; // null = HEAD détachée
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
  state: RepoState;
}

export type RepoState = 'clean' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';

export interface Branch {
  name: string;
  sha: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
}

/** Un tag (`refs/tags/*`). */
export interface Tag {
  name: string;
  /** Commit pointé (tag annoté déréférencé) ; null si le tag vise un autre objet (arbre, blob, tag imbriqué). */
  sha: string | null;
  annotated: boolean;
  /** Sujet de l'annotation ; '' pour un tag léger. */
  subject: string;
  date: number; // secondes epoch (date du tag annoté, du commit pour un tag léger ; 0 si inconnue)
}

/** Un remote configuré ; une URL absente vaut null (la première si plusieurs). */
export interface Remote {
  name: string;
  fetchUrl: string | null;
  /** URL de push distincte (`pushurl`), `null` si elle est identique à `fetchUrl`. URL effectives (après `insteadOf`). */
  pushUrl: string | null;
}

export interface Stash {
  index: number;
  ref: string;
  sha: string;
  message: string;
}

/** Une version d'un fichier dans son historique (`git log --follow`). */
export interface FileRevision {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  date: number; // secondes epoch
  subject: string;
  path: string; // chemin du fichier dans ce commit
  oldPath?: string; // chemin avant un renommage ou une copie
  status: FileStatusCode;
}

export interface BlameCommit {
  sha: string;
  author: string;
  email: string;
  date: number; // secondes epoch
  summary: string;
}

export interface BlameLine {
  sha: string; // 0000000… pour une ligne non commitée
  origLine: number; // numéro de la ligne dans le commit d'origine
  line: number; // numéro de la ligne dans la version affichée
  text: string;
}

export interface Blame {
  commits: Record<string, BlameCommit>;
  lines: BlameLine[];
}

export interface RepoSnapshot {
  path: string;
  name: string;
  commits: Commit[];
  branches: Branch[];
  tags: Tag[]; // plus récent d'abord
  remotes: Remote[];
  stashes: Stash[];
  status: WorkingStatus;
  head: string | null;
}

/** Le dépôt a changé hors d'Arbor : `git` = références, index ou opération en cours ; `worktree` = fichiers. */
export interface RepoChangeEvent {
  repo: string;
  scope: 'git' | 'worktree';
}

/** La surveillance de l'arbre de travail a dû être réduite (trop de fichiers) : message à afficher une fois. */
export interface WatchLimitedEvent {
  repo: string;
  message: string;
}

export type DiffTarget =
  | { kind: 'working'; path: string; oldPath?: string; staged: boolean; untracked?: boolean; conflict?: boolean }
  | { kind: 'commit'; sha: string; path: string; oldPath?: string };

/** Blocs (et éventuellement lignes) choisis dans un diff : `lines` absent = bloc entier ; indices dans `Hunk.lines`. */
export type PatchSelection = { hunk: number; lines?: number[] }[];
export type PatchAction = 'stage' | 'unstage' | 'discard';

export interface ArborApi {
  openRepoDialog(): Promise<string | null>;
  initRepoDialog(): Promise<string | null>;
  cloneRepo(url: string): Promise<string | null>;
  recentRepos(): Promise<string[]>;
  snapshot(repo: string): Promise<RepoSnapshot>;
  searchCommitsByPath(repo: string, text: string): Promise<FileSearchResult>;
  commitFiles(repo: string, sha: string): Promise<FileChange[]>;
  diff(repo: string, target: DiffTarget): Promise<string>;
  readFile(repo: string, path: string): Promise<string>;
  /**
   * Commits qui ont modifié un fichier (renommages suivis), par pages de 200 ; `rev` null = HEAD.
   * `skip` compte les commits parcourus depuis `rev` (pas les versions) : pour la page suivante,
   * passer la dernière version chargée (`oldPath ?? path`, `sha`) avec `skip` = 1.
   */
  fileLog(repo: string, path: string, rev: string | null, skip: number): Promise<FileRevision[]>;
  /** Auteur de chaque ligne ; `rev` null = arbre de travail (lignes non commitées comprises). */
  blame(repo: string, path: string, rev: string | null): Promise<Blame>;
  stage(repo: string, paths: string[]): Promise<void>;
  unstage(repo: string, paths: string[]): Promise<void>;
  discard(repo: string, paths: string[]): Promise<void>;
  applyPatchSelection(repo: string, target: DiffTarget, shown: string, sel: PatchSelection, action: PatchAction): Promise<void>;
  commit(repo: string, message: string, amend: boolean): Promise<void>;
  checkout(repo: string, ref: string): Promise<void>;
  createBranch(repo: string, name: string, from: string, checkout: boolean): Promise<void>;
  deleteBranch(repo: string, name: string, force: boolean): Promise<void>;
  merge(repo: string, ref: string): Promise<void>;
  rebase(repo: string, onto: string): Promise<void>;
  abort(repo: string): Promise<void>;
  continueOp(repo: string): Promise<void>;
  resolve(repo: string, path: string, side: 'mine' | 'theirs'): Promise<void>;
  fetch(repo: string): Promise<void>;
  pull(repo: string): Promise<void>;
  push(repo: string, setUpstream: boolean): Promise<void>;
  stashSave(repo: string, message: string): Promise<void>;
  stashApply(repo: string, index: number, sha: string, pop: boolean): Promise<void>;
  stashDrop(repo: string, index: number, sha: string): Promise<void>;
  initialRepo(): Promise<string | null>;
  /** Tag léger si `message` est null, annoté sinon. */
  createTag(repo: string, name: string, sha: string, message: string | null): Promise<void>;
  cherryPick(repo: string, sha: string): Promise<void>;
  revert(repo: string, sha: string): Promise<void>;
  reset(repo: string, sha: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void>;
  /** Surveille ce dépôt (un seul à la fois) et émet l'événement `repoChanged`. */
  watchRepo(repo: string): Promise<void>;
  unwatchRepo(): Promise<void>;
  /** Préférences de l'utilisateur (`userData/prefs.json`), normalisées. */
  getPreferences(): Promise<Preferences>;
  /** Fusionne un correctif dans les préférences, les enregistre et renvoie le résultat normalisé. */
  setPreferences(patch: Partial<Preferences>): Promise<Preferences>;
  /** Onglets de la session précédente (`userData/session.json`) ; dépôts supprimés écartés, dépôts inaccessibles gardés
   * par le processus principal pour un prochain lancement (voir `shared/session.ts`), récents inchangés. */
  restoreSession(): Promise<{ repos: string[]; active: number }>;
  /** Enregistre les onglets ouverts (seuls les dépôts ouverts dans Arbor sont retenus). */
  saveSession(repos: string[], active: number): Promise<void>;
  // remotes
  /** URL brutes d'un remote telles qu'écrites dans la configuration (avant `insteadOf`), pour les éditer. */
  remoteConfig(repo: string, name: string): Promise<RemoteConfig>;
  /** Ajoute un remote ; `pushUrl` null = même URL que le fetch ; `fetch` récupère ses branches aussitôt. */
  addRemote(repo: string, name: string, url: string, pushUrl: string | null, fetch: boolean): Promise<void>;
  renameRemote(repo: string, oldName: string, newName: string): Promise<void>;
  /** Supprime le remote, ses branches distantes et la configuration de suivi qui le référence. */
  removeRemote(repo: string, name: string): Promise<void>;
  /** URL de fetch (`push` faux) ou de push ; pour le push, `url` null retire `pushurl`. */
  setRemoteUrl(repo: string, name: string, url: string | null, push: boolean): Promise<void>;
  fetchRemote(repo: string, name: string): Promise<void>;
  pruneRemote(repo: string, name: string): Promise<void>;
  // tags
  /** Checkout de `refs/tags/<name>` (HEAD détachée). */
  checkoutTag(repo: string, name: string): Promise<void>;
  deleteTag(repo: string, name: string): Promise<void>;
  /** Supprime `refs/tags/<name>` sur le remote. */
  deleteRemoteTag(repo: string, remote: string, name: string): Promise<void>;
  pushTag(repo: string, remote: string, name: string): Promise<void>;
  pushAllTags(repo: string, remote: string): Promise<void>;
  /** Tags du remote (`git ls-remote`, accès réseau). */
  remoteTags(repo: string, remote: string): Promise<RemoteTag[]>;
}

/** Valeurs brutes de `remote.<nom>.url` et `remote.<nom>.pushurl` (plusieurs possibles, souvent zéro ou une). */
export interface RemoteConfig {
  urls: string[];
  pushUrls: string[];
}

/** Tag présent sur un remote (`git ls-remote --tags --refs`) : `sha` = objet pointé (le tag annoté lui-même). */
export interface RemoteTag {
  name: string;
  sha: string;
}
