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

export interface Stash {
  index: number;
  ref: string;
  message: string;
}

export interface RepoSnapshot {
  path: string;
  name: string;
  commits: Commit[];
  branches: Branch[];
  tags: string[];
  remotes: string[];
  stashes: Stash[];
  status: WorkingStatus;
  head: string | null;
}

export type DiffTarget =
  | { kind: 'working'; path: string; staged: boolean; untracked?: boolean; conflict?: boolean }
  | { kind: 'commit'; sha: string; path: string };

export interface ArborApi {
  openRepoDialog(): Promise<string | null>;
  initRepoDialog(): Promise<string | null>;
  cloneRepo(url: string): Promise<string | null>;
  recentRepos(): Promise<string[]>;
  snapshot(repo: string): Promise<RepoSnapshot>;
  commitFiles(repo: string, sha: string): Promise<FileChange[]>;
  diff(repo: string, target: DiffTarget): Promise<string>;
  readFile(repo: string, path: string): Promise<string>;
  stage(repo: string, paths: string[]): Promise<void>;
  unstage(repo: string, paths: string[]): Promise<void>;
  discard(repo: string, paths: string[]): Promise<void>;
  commit(repo: string, message: string, amend: boolean): Promise<void>;
  checkout(repo: string, ref: string): Promise<void>;
  createBranch(repo: string, name: string, from: string, checkout: boolean): Promise<void>;
  deleteBranch(repo: string, name: string, force: boolean): Promise<void>;
  merge(repo: string, ref: string): Promise<void>;
  rebase(repo: string, onto: string): Promise<void>;
  abort(repo: string): Promise<void>;
  continueOp(repo: string): Promise<void>;
  resolve(repo: string, path: string, side: 'ours' | 'theirs'): Promise<void>;
  fetch(repo: string): Promise<void>;
  pull(repo: string): Promise<void>;
  push(repo: string, setUpstream: boolean): Promise<void>;
  stashSave(repo: string, message: string): Promise<void>;
  stashApply(repo: string, index: number, pop: boolean): Promise<void>;
  stashDrop(repo: string, index: number): Promise<void>;
  initialRepo(): Promise<string | null>;
  createTag(repo: string, name: string, sha: string): Promise<void>;
  cherryPick(repo: string, sha: string): Promise<void>;
  revert(repo: string, sha: string): Promise<void>;
  reset(repo: string, sha: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void>;
}
