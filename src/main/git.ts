import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile as fsReadFile, realpath } from 'node:fs/promises';
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

const GIT_ERRORS: [RegExp, (m: RegExpMatchArray) => string][] = [
  // Les conflits passent en premier : leur sortie contient aussi l'état du dépôt (« no changes added… »).
  [/CONFLICT|Automatic merge failed|could not apply|after resolving the conflicts|Index was not unstashed/, () => 'Des conflits sont apparus : résolvez-les depuis la liste « Conflits ».'],
  [/branch '(.+?)' is not fully merged/, (m) => `La branche « ${m[1]} » n'est pas entièrement fusionnée. Cochez « Forcer » pour la supprimer quand même.`],
  [/local changes to the following files would be overwritten/, () => 'Vos modifications locales seraient écrasées. Commitez-les ou mettez-les de côté (stash) avant.'],
  [/untracked working tree files would be (?:overwritten|removed)/, () => 'Des fichiers non suivis seraient écrasés. Déplacez-les, ajoutez-les ou mettez-les de côté (stash) avant.'],
  [/(?:branch named|tag) '(.+?)' already exists/i, (m) => `« ${m[1]} » existe déjà.`],
  [/is not a valid (?:branch|tag) name|not a valid ref name/, () => 'Nom invalide pour Git (espaces, « .. », « ~ », « ^ », « : » et « \\ » sont interdits).'],
  [/\[rejected\].*\((?:fetch first|non-fast-forward)\)/, () => 'Push refusé : la branche distante contient des commits que vous n\'avez pas. Faites un pull d\'abord.'],
  [/Authentication failed|could not read Username|Permission denied \(publickey/, () => 'Authentification refusée par le serveur distant. Vérifiez vos identifiants ou votre clé SSH.'],
  [/Could not resolve host|Connection timed out|unable to access/, () => 'Serveur distant injoignable. Vérifiez la connexion et l\'URL du remote.'],
  [/Please tell me who you are|empty ident name/, () => 'Identité Git non configurée : définissez user.name et user.email (git config --global).'],
  [/nothing to commit|no changes added to commit/, () => 'Rien à commiter.'],
  [/Not possible to fast-forward|Need to specify how to reconcile divergent branches/, () => 'Les branches ont divergé : le pull ne peut pas avancer simplement. Fusionnez ou rebasez la branche distante.'],
  [/There is no tracking information|has no upstream branch/, () => 'Cette branche ne suit aucune branche distante.'],
  [/You have unstaged changes|cannot (?:rebase|pull with rebase): You have unstaged changes/, () => 'Des modifications non commitées empêchent l\'opération. Commitez-les ou mettez-les de côté (stash).'],
];

/** Traduit les erreurs Git courantes en français ; sinon renvoie la fin du message d'origine. */
export function translateGitError(raw: string): string {
  for (const [re, fmt] of GIT_ERRORS) {
    const m = raw.match(re);
    if (m) return fmt(m);
  }
  const tail = raw.split('\n').filter(Boolean).slice(-4).join('\n');
  return `Git a renvoyé une erreur :\n${tail}`;
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
          // Certains messages (CONFLICT…) sont écrits sur stdout : on garde les deux flux.
          const msg = [stderr, stdout.slice(-4000)].filter((t) => t.trim()).join('\n').trim() || err.message;
          reject(new GitError(translateGitError(msg), msg));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

const FS = '\x1f';

/** Format de `git log -z` : enregistrements séparés par NUL, message brut (%B) en dernier. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%B'].join(FS);

export function parseLog(out: string): Commit[] {
  return out
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      // Le message peut contenir n'importe quel caractère sauf NUL : seuls les 6 premiers séparateurs comptent.
      const fields = rec.split(FS);
      const [sha, parents, author, email, date, refs] = fields;
      const message = fields.slice(6).join(FS);
      const nl = message.indexOf('\n');
      return {
        sha,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        date: Number(date),
        subject: (nl === -1 ? message : message.slice(0, nl)).trim(),
        body: nl === -1 ? '' : message.slice(nl + 1).trim(),
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

export async function log(repo: string, hasHead: boolean, limit = 3000): Promise<Commit[]> {
  // Branches, remotes et tags (pas les notes ni les stashs) ; HEAD seulement s'il existe (HEAD détachée).
  const out = await git(repo, [
    'log',
    '-z',
    '--date-order',
    '--decorate=full',
    `--max-count=${limit}`,
    `--format=${LOG_FORMAT}`,
    '--branches',
    '--remotes',
    '--tags',
    ...(hasHead ? ['HEAD'] : []),
    '--',
  ]);
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
  const out = await git(repo, ['stash', 'list', `--format=%gd${FS}%H${FS}%gs`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const [ref, sha, message] = line.split(FS);
      return { index, ref, sha, message };
    });
}

export async function headSha(repo: string): Promise<string | null> {
  return (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] })).trim() || null;
}

export async function snapshot(repo: string): Promise<RepoSnapshot> {
  const head = await headSha(repo);
  const [commits, br, tagsOut, remotesOut, st, stashList] = await Promise.all([
    log(repo, head !== null),
    branches(repo),
    git(repo, ['tag', '--list']),
    git(repo, ['remote']),
    status(repo),
    stashes(repo),
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
    head,
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

/** Chemins d'un fichier pour un diff : l'ancien chemin d'un renommage est inclus pour que git le détecte. */
const diffPaths = (t: { path: string; oldPath?: string }) => (t.oldPath ? [t.oldPath, t.path] : [t.path]);

export async function diff(repo: string, t: DiffTarget): Promise<string> {
  if (t.kind === 'commit') {
    const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', '--end-of-options', t.sha, '--'])).trim().split(' ').slice(1);
    if (parents.length === 0) return git(repo, ['show', '--format=', '-M', '--end-of-options', t.sha, '--', ...diffPaths(t)]);
    return git(repo, ['diff', '-M', '--end-of-options', parents[0], t.sha, '--', ...diffPaths(t)]);
  }
  if (t.untracked) {
    return git(repo, ['diff', '--no-index', '--', '/dev/null', t.path], { okCodes: [1] });
  }
  return git(repo, ['diff', '-M', ...(t.staged ? ['--cached'] : []), '--', ...diffPaths(t)]);
}

export async function readFile(repo: string, path: string): Promise<string> {
  // Comparaison sur les chemins réels : un lien symbolique ne doit pas permettre de sortir du dépôt.
  const root = await realpath(repo);
  const full = await realpath(resolvePath(root, path));
  if (!full.startsWith(root + sep)) throw new GitError('Chemin en dehors du dépôt.', '');
  return fsReadFile(full, 'utf8');
}

export async function stage(repo: string, paths: string[]) {
  await git(repo, ['add', '-A', '--', ...paths]);
}

export async function unstage(repo: string, paths: string[]) {
  if (await headSha(repo)) await git(repo, ['reset', '-q', 'HEAD', '--', ...paths]);
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

/** Refuse un nom de branche ou de tag invalide (y compris ceux qui commencent par « - »). */
async function checkRefName(repo: string, kind: 'branch' | 'tag', name: string) {
  const args = kind === 'branch' ? ['--branch', name] : [`refs/tags/${name}`];
  const valid = !name.startsWith('-') && (await git(repo, ['check-ref-format', ...args]).then(() => true, () => false));
  if (!valid) throw new GitError(`« ${name} » n'est pas un nom de ${kind === 'branch' ? 'branche' : 'tag'} valide.`, '');
}

const SHA_RE = /^[0-9a-f]{4,64}$/i;

/** Garantit qu'une révision est un SHA : `checkout` et `reset` n'acceptent pas `--end-of-options`. */
function assertSha(rev: string) {
  if (!SHA_RE.test(rev)) throw new GitError(`« ${rev} » n'est pas un identifiant de commit.`, '');
}

export async function checkout(repo: string, ref: string) {
  // `git checkout` ne gère pas `--end-of-options` : chaque cas passe par un nom complet ou un SHA vérifié.
  const br = await branches(repo);
  const target = br.find((b) => b.name === ref);
  if (target?.remote) {
    // Une branche distante crée une branche locale qui la suit.
    const local = ref.split('/').slice(1).join('/');
    await checkRefName(repo, 'branch', local);
    if (br.some((b) => !b.remote && b.name === local)) await git(repo, ['checkout', local]);
    else await git(repo, ['checkout', '--track', '-b', local, `refs/remotes/${ref}`]);
    return;
  }
  if (target) {
    await checkRefName(repo, 'branch', ref);
    await git(repo, ['checkout', ref]);
    return;
  }
  const tags = (await git(repo, ['tag', '--list'])).split('\n');
  if (tags.includes(ref)) {
    await git(repo, ['checkout', '--detach', `refs/tags/${ref}`]);
    return;
  }
  assertSha(ref);
  await git(repo, ['checkout', '--detach', ref]);
}

export async function createBranch(repo: string, name: string, from: string, doCheckout: boolean) {
  await checkRefName(repo, 'branch', name);
  if (doCheckout) {
    // `checkout -b` ne gère pas `--end-of-options` : le point de départ est d'abord résolu en SHA.
    const sha = (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`])).trim();
    assertSha(sha);
    await git(repo, ['checkout', '-b', name, sha]);
  } else {
    await git(repo, ['branch', '--end-of-options', name, from]);
  }
}

export async function deleteBranch(repo: string, name: string, force: boolean) {
  await git(repo, ['branch', force ? '-D' : '-d', '--end-of-options', name]);
}

export async function merge(repo: string, ref: string) {
  await git(repo, ['merge', '--no-edit', '--end-of-options', ref]);
}

export async function rebase(repo: string, onto: string) {
  await git(repo, ['rebase', '--end-of-options', onto]);
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

/**
 * Côté git correspondant à « ma version » / « leur version ».
 * Pendant un rebase, git inverse les rôles : « ours » est la base sur laquelle on rejoue, « theirs » le commit de l'utilisateur.
 */
export function gitSide(state: RepoState, side: 'mine' | 'theirs'): 'ours' | 'theirs' {
  const mine = state === 'rebasing' ? 'theirs' : 'ours';
  return side === 'mine' ? mine : mine === 'ours' ? 'theirs' : 'ours';
}

export async function resolve(repo: string, path: string, side: 'mine' | 'theirs') {
  const state = await repoState(repo);
  await git(repo, ['checkout', `--${gitSide(state, side)}`, '--', path]);
  await git(repo, ['add', '--', path]);
}

export async function fetch(repo: string) {
  await git(repo, ['fetch', '--all', '--prune']);
}

export async function pull(repo: string) {
  await git(repo, ['pull', '--ff']);
}

/** Remote sur lequel publier une nouvelle branche : origin s'il existe, sinon l'unique remote. */
export function pushRemote(remotes: string[]): string {
  if (remotes.includes('origin')) return 'origin';
  if (remotes.length === 1) return remotes[0];
  throw new GitError(remotes.length ? 'Plusieurs remotes sans « origin » : impossible de choisir où publier.' : 'Aucun remote configuré.', '');
}

export async function push(repo: string, setUpstream: boolean) {
  if (setUpstream) {
    const st = await status(repo);
    if (!st.branch) throw new GitError('HEAD détachée : impossible de pousser.', '');
    const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
    await git(repo, ['push', '-u', '--end-of-options', pushRemote(remotes), st.branch]);
  } else {
    await git(repo, ['push']);
  }
}

export async function stashSave(repo: string, message: string) {
  await git(repo, ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])]);
}

/** Vérifie que stash@{index} est toujours le stash affiché (un autre outil a pu en ajouter un entre-temps). */
async function stashRef(repo: string, index: number, sha: string): Promise<string> {
  const ref = `stash@{${index}}`;
  const actual = (await git(repo, ['rev-parse', '--verify', '-q', ref], { okCodes: [1] })).trim();
  if (actual !== sha) throw new GitError('La liste des stashs a changé : rafraîchissez et réessayez.', '');
  return ref;
}

export async function stashApply(repo: string, index: number, sha: string, pop: boolean) {
  const ref = await stashRef(repo, index, sha);
  const args = ['stash', pop ? 'pop' : 'apply'];
  // Restaure aussi l'indexation ; si elle ne peut pas être reconstruite, on se rabat sur les seules modifications.
  try {
    await git(repo, [...args, '--index', ref]);
  } catch (e) {
    // Repli uniquement quand git refuse de reconstruire l'index ; un conflit, lui, doit remonter tel quel.
    if (!(e instanceof GitError && /Conflicts in index|without --index/.test(e.stderr))) throw e;
    await git(repo, [...args, ref]);
  }
}

export async function stashDrop(repo: string, index: number, sha: string) {
  await git(repo, ['stash', 'drop', await stashRef(repo, index, sha)]);
}

export async function createTag(repo: string, name: string, sha: string) {
  await checkRefName(repo, 'tag', name);
  await git(repo, ['tag', '--end-of-options', name, sha]);
}

export async function cherryPick(repo: string, sha: string) {
  await git(repo, ['cherry-pick', '--end-of-options', sha]);
}

export async function revert(repo: string, sha: string) {
  await git(repo, ['revert', '--no-edit', '--end-of-options', sha]);
}

export async function reset(repo: string, sha: string, mode: 'soft' | 'mixed' | 'hard') {
  assertSha(sha);
  await git(repo, ['reset', `--${mode}`, sha, '--']);
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
