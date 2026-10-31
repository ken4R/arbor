import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath, sep } from 'node:path';
import type {
  Branch,
  Commit,
  DiffTarget,
  FileChange,
  FileStatusCode,
  Ref,
  RepoSnapshot,
  RepoState,
  Stash,
  WorkingStatus,
} from '../shared/types';

export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

interface RunOptions {
  okCodes?: number[];
}

export function git(repo: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: repo, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        if (err && !(opts.okCodes ?? []).includes(code)) {
          const msg = (stderr || err.message).trim();
          reject(new GitError(msg.split('\n').slice(-6).join('\n'), stderr));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

const FS = '\x1f';
const RS = '\x1e';

export function parseLog(out: string): Commit[] {
  return out
    .split(RS)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, parents, author, email, date, subject, refs, body] = rec.split(FS);
      return {
        sha,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        date: Number(date),
        subject,
        body: (body ?? '').trim(),
        refs: parseRefs(refs ?? ''),
      };
    });
}

export function parseRefs(decoration: string): Ref[] {
  const refs: Ref[] = [];
  for (const raw of decoration.split(', ').map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith('HEAD -> ')) {
      refs.push({ name: 'HEAD', type: 'head' });
      refs.push({ name: raw.slice(8).replace(/^refs\/heads\//, ''), type: 'local' });
    } else if (raw === 'HEAD') {
      refs.push({ name: 'HEAD', type: 'head' });
    } else if (raw.startsWith('tag: ')) {
      refs.push({ name: raw.slice(5).replace(/^refs\/tags\//, ''), type: 'tag' });
    } else if (raw.startsWith('refs/remotes/')) {
      const name = raw.slice(13);
      if (!name.endsWith('/HEAD')) refs.push({ name, type: 'remote' });
    } else if (raw.startsWith('refs/heads/')) {
      refs.push({ name: raw.slice(11), type: 'local' });
    } else if (raw.startsWith('refs/stash')) {
      // les stashs sont affichés dans la barre latérale
    } else {
      refs.push({ name: raw, type: 'local' });
    }
  }
  return refs;
}

function statusCode(c: string): FileStatusCode {
  return (c === '?' ? '?' : c) as FileStatusCode;
}

/** Analyse `git status --porcelain=v1 -z -b`. */
export function parseStatus(out: string): Omit<WorkingStatus, 'state'> {
  const parts = out.split('\0');
  const result: Omit<WorkingStatus, 'state'> = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    conflicted: [],
  };
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith('## ')) {
      const header = entry.slice(3);
      const m = header.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
      if (m) {
        const name = m[1];
        if (name.startsWith('No commits yet on ')) result.branch = name.slice(18);
        else if (name.startsWith('Initial commit on ')) result.branch = name.slice(18);
        else if (name !== 'HEAD (no branch)') result.branch = name;
        result.upstream = m[2] ?? null;
        const track = m[3] ?? '';
        result.ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
        result.behind = Number(track.match(/behind (\d+)/)?.[1] ?? 0);
      }
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    let oldPath: string | undefined;
    if (x === 'R' || x === 'C') oldPath = parts[++i];
    const xy = x + y;
    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)) {
      result.conflicted.push({ path, status: 'U' });
      continue;
    }
    if (xy === '??') {
      result.unstaged.push({ path, status: '?' });
      continue;
    }
    if (x !== ' ') result.staged.push({ path, oldPath, status: statusCode(x) });
    if (y !== ' ') result.unstaged.push({ path, status: statusCode(y) });
  }
  return result;
}

async function gitDir(repo: string): Promise<string> {
  const dir = (await git(repo, ['rev-parse', '--git-dir'])).trim();
  return dir.startsWith('/') || /^[A-Za-z]:/.test(dir) ? dir : join(repo, dir);
}

async function repoState(repo: string): Promise<RepoState> {
  const dir = await gitDir(repo);
  if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebasing';
  if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merging';
  if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking';
  if (existsSync(join(dir, 'REVERT_HEAD'))) return 'reverting';
  return 'clean';
}

export async function status(repo: string): Promise<WorkingStatus> {
  const [out, state] = await Promise.all([
    git(repo, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']),
    repoState(repo),
  ]);
  return { ...parseStatus(out), state };
}

export async function log(repo: string, limit = 3000): Promise<Commit[]> {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%s', '%D', '%b'].join(FS) + RS;
  const out = await git(
    repo,
    ['log', '--date-order', '--decorate=full', `--max-count=${limit}`, `--format=${fmt}`, '--exclude=refs/stash', '--all'],
    { okCodes: [128] }, // dépôt sans commit
  );
  return parseLog(out);
}

export async function branches(repo: string): Promise<Branch[]> {
  const fmt = ['%(refname)', '%(objectname)', '%(HEAD)', '%(upstream:short)'].join(FS);
  const out = await git(repo, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, head, upstream] = line.split(FS);
      const remote = ref.startsWith('refs/remotes/');
      return {
        name: ref.replace(/^refs\/(heads|remotes)\//, ''),
        sha,
        current: head === '*',
        remote,
        upstream: upstream || null,
      };
    })
    .filter((b) => !(b.remote && b.name.endsWith('/HEAD')));
}

export async function stashes(repo: string): Promise<Stash[]> {
  const out = await git(repo, ['stash', 'list', `--format=%gd${FS}%gs`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const [ref, message] = line.split(FS);
      return { index, ref, message };
    });
}

export async function snapshot(repo: string): Promise<RepoSnapshot> {
  const [commits, br, tagsOut, remotesOut, st, stashList, headOut] = await Promise.all([
    log(repo),
    branches(repo),
    git(repo, ['tag', '--list']),
    git(repo, ['remote']),
    status(repo),
    stashes(repo),
    git(repo, ['rev-parse', 'HEAD'], { okCodes: [128] }),
  ]);
  return {
    path: repo,
    name: basename(repo),
    commits,
    branches: br,
    tags: tagsOut.split('\n').filter(Boolean),
    remotes: remotesOut.split('\n').filter(Boolean),
    stashes: stashList,
    status: st,
    head: headOut.trim() || null,
  };
}

export function parseNameStatus(out: string): FileChange[] {
  const parts = out.split('\0').filter((p) => p !== '');
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    const status = code[0] as FileStatusCode;
    if (status === 'R' || status === 'C') {
      files.push({ status, oldPath: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      files.push({ status, path: parts[i + 1] });
      i += 1;
    }
  }
  return files;
}

export async function commitFiles(repo: string, sha: string): Promise<FileChange[]> {
  const out = await git(repo, ['diff-tree', '-r', '-z', '-M', '--name-status', '--root', '--no-commit-id', '-m', '--first-parent', sha]);
  return parseNameStatus(out);
}

export async function diff(repo: string, t: DiffTarget): Promise<string> {
  if (t.kind === 'commit') {
    const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', t.sha])).trim().split(' ').slice(1);
    if (parents.length === 0) return git(repo, ['show', '--format=', '-M', t.sha, '--', t.path]);
    return git(repo, ['diff', '-M', parents[0], t.sha, '--', t.path]);
  }
  if (t.untracked) {
    return git(repo, ['diff', '--no-index', '--', '/dev/null', t.path], { okCodes: [1] });
  }
  return git(repo, ['diff', ...(t.staged ? ['--cached'] : []), '--', t.path]);
}

export async function readFile(repo: string, path: string): Promise<string> {
  const full = resolvePath(repo, path);
  if (!full.startsWith(resolvePath(repo) + sep)) throw new GitError('Chemin en dehors du dépôt.', '');
  return fsReadFile(full, 'utf8');
}

export async function stage(repo: string, paths: string[]) {
  await git(repo, ['add', '-A', '--', ...paths]);
}

export async function unstage(repo: string, paths: string[]) {
  const hasHead = (await git(repo, ['rev-parse', '--verify', 'HEAD'], { okCodes: [128] })).trim();
  if (hasHead) await git(repo, ['reset', '-q', 'HEAD', '--', ...paths]);
  else await git(repo, ['rm', '--cached', '-r', '-q', '--', ...paths]);
}

export async function discard(repo: string, paths: string[]) {
  const st = await status(repo);
  const untracked = new Set(st.unstaged.filter((f) => f.status === '?').map((f) => f.path));
  const tracked = paths.filter((p) => !untracked.has(p));
  const toClean = paths.filter((p) => untracked.has(p));
  if (tracked.length) await git(repo, ['checkout', '--', ...tracked]);
  if (toClean.length) await git(repo, ['clean', '-f', '--', ...toClean]);
}

export async function commit(repo: string, message: string, amend: boolean) {
  await git(repo, ['commit', '-m', message, ...(amend ? ['--amend'] : [])]);
}

export async function checkout(repo: string, ref: string) {
  // Une branche distante crée une branche locale qui la suit.
  const br = await branches(repo);
  const target = br.find((b) => b.name === ref);
  if (target?.remote) {
    const local = ref.split('/').slice(1).join('/');
    if (br.some((b) => !b.remote && b.name === local)) await git(repo, ['checkout', local]);
    else await git(repo, ['checkout', '-b', local, '--track', ref]);
    return;
  }
  await git(repo, ['checkout', ref]);
}

export async function createBranch(repo: string, name: string, from: string, doCheckout: boolean) {
  if (doCheckout) await git(repo, ['checkout', '-b', name, from]);
  else await git(repo, ['branch', name, from]);
}

export async function deleteBranch(repo: string, name: string, force: boolean) {
  await git(repo, ['branch', force ? '-D' : '-d', name]);
}

export async function merge(repo: string, ref: string) {
  await git(repo, ['merge', '--no-edit', ref]);
}

export async function rebase(repo: string, onto: string) {
  await git(repo, ['rebase', onto]);
}

export async function abort(repo: string) {
  const state = await repoState(repo);
  const cmd = { merging: 'merge', rebasing: 'rebase', 'cherry-picking': 'cherry-pick', reverting: 'revert', clean: null }[state];
  if (cmd) await git(repo, [cmd, '--abort']);
}

export async function continueOp(repo: string) {
  const state = await repoState(repo);
  if (state === 'merging') await git(repo, ['commit', '--no-edit']);
  else if (state === 'rebasing') await git(repo, ['rebase', '--continue']);
  else if (state === 'cherry-picking') await git(repo, ['cherry-pick', '--continue']);
  else if (state === 'reverting') await git(repo, ['revert', '--continue']);
}

export async function resolve(repo: string, path: string, side: 'ours' | 'theirs') {
  await git(repo, ['checkout', `--${side}`, '--', path]);
  await git(repo, ['add', '--', path]);
}

export async function fetch(repo: string) {
  await git(repo, ['fetch', '--all', '--prune']);
}

export async function pull(repo: string) {
  await git(repo, ['pull', '--ff']);
}

export async function push(repo: string, setUpstream: boolean) {
  if (setUpstream) {
    const st = await status(repo);
    if (!st.branch) throw new GitError('HEAD détachée : impossible de pousser.', '');
    await git(repo, ['push', '-u', 'origin', st.branch]);
  } else {
    await git(repo, ['push']);
  }
}

export async function stashSave(repo: string, message: string) {
  await git(repo, ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])]);
}

export async function stashApply(repo: string, index: number, pop: boolean) {
  await git(repo, ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`]);
}

export async function stashDrop(repo: string, index: number) {
  await git(repo, ['stash', 'drop', `stash@{${index}}`]);
}

export async function createTag(repo: string, name: string, sha: string) {
  await git(repo, ['tag', name, sha]);
}

export async function cherryPick(repo: string, sha: string) {
  await git(repo, ['cherry-pick', sha]);
}

export async function revert(repo: string, sha: string) {
  await git(repo, ['revert', '--no-edit', sha]);
}

export async function reset(repo: string, sha: string, mode: 'soft' | 'mixed' | 'hard') {
  await git(repo, ['reset', `--${mode}`, sha]);
}

export async function isRepo(path: string): Promise<boolean> {
  try {
    await git(path, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export async function toplevel(path: string): Promise<string> {
  return (await git(path, ['rev-parse', '--show-toplevel'])).trim();
}
