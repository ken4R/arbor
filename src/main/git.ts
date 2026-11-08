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
  Remote,
  RepoState,
  Stash,
  Tag,
  WorkingStatus,
} from '../shared/types';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { RebasePlan } from '../shared/types';
import { REBASE_MIN_GIT, buildTodo, gitVersionAtLeast, parseGitVersion, progressFromFiles, todoWithoutOrphanedGroup, validateSteps, type RebaseProgress, type RebaseStep } from '../shared/rebase';

export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

const GIT_ERRORS: [RegExp, (m: RegExpMatchArray) => string][] = [
  // Avant les conflits : un commit devenu vide pendant un rebase sort aussi « could not apply ».
  [/previous cherry-pick is now empty/, () => 'Le commit en cours est devenu vide (ses changements sont déjà présents) : retirez-le avec Passer (ou Continuer pendant un rebase).'],
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
  [/patch does not apply|corrupt patch/, () => 'Le bloc ne s\'applique plus : rafraîchissez.'],
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
  /** Texte écrit sur l'entrée standard (patch pour `git apply -`). */
  input?: string;
  /** Variables d'environnement ajoutées après les valeurs par défaut (rebase interactif). */
  env?: Record<string, string>;
}

export function git(repo: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: repo, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C', ...opts.env } },
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
    // git peut se terminer sans lire l'entrée (EPIPE) : l'erreur est déjà remontée par le code de sortie.
    child.stdin?.on('error', () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
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

async function repoState(repo: string, knownDir?: string): Promise<RepoState> {
  const dir = knownDir ?? (await gitDir(repo));
  if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebasing';
  if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merging';
  if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking';
  if (existsSync(join(dir, 'REVERT_HEAD'))) return 'reverting';
  return 'clean';
}

export async function status(repo: string): Promise<WorkingStatus> {
  const [out, dir] = await Promise.all([
    git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']),
    gitDir(repo),
  ]);
  const state = await repoState(repo, dir);
  const parsed = parseStatus(out);
  if (state !== 'rebasing') {
    await cleanupRebaseScratch(repo, dir);
    return { ...parsed, state };
  }
  const clean = parsed.staged.length === 0 && parsed.unstaged.every((f) => f.status === '?');
  return { ...parsed, state, rebase: await rebaseProgress(repo, parsed.conflicted.length, clean, dir) };
}

// Surveillance du dépôt (rafraîchissement automatique). `status` ci-dessus passe `--no-optional-locks` :
// sans cette option, il réécrirait l'index et la surveillance se redéclencherait en boucle.

/** Dossier Git de l'arbre de travail et dossier commun (différents pour un worktree lié), en chemins absolus. */
export async function gitDirs(repo: string): Promise<{ gitDir: string; commonDir: string }> {
  const [gitDirOut = '', commonOut = ''] = (await git(repo, ['rev-parse', '--git-dir', '--git-common-dir'])).split('\n');
  return { gitDir: resolvePath(repo, gitDirOut.trim()), commonDir: resolvePath(repo, commonOut.trim() || gitDirOut.trim()) };
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Décode un chemin que Git a mis entre guillemets à la manière du C (`"dir/a\"b"`, `"\303\251"`) ; sinon le renvoie tel quel. */
export function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
    } else if (/^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      const next = body[++i];
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Chemins (relatifs à la racine) que Git ignore, vérifiés par lots de 50 passés en arguments.
 * `-z` n'est accepté qu'avec `--stdin` : la sortie est donc une ligne par chemin, entre guillemets si besoin.
 * Un lot refusé par Git (chemin dans un sous-module…) est revérifié chemin par chemin ; un chemin que Git refuse
 * de vérifier est compté comme ignoré (l'intérieur des sous-modules n'est pas suivi). Ne lève jamais.
 */
export async function ignoredPaths(repo: string, paths: string[]): Promise<Set<string>> {
  const ignored = new Set<string>();
  // `:x` serait lu comme une « pathspec magic » : on le passe en `./:x`, que Git renvoie tel quel.
  const toArg = (p: string) => (p.startsWith(':') ? `./${p}` : p);
  const fromArg = new Map(paths.map((p) => [toArg(p), p]));
  const check = async (batch: string[]) => {
    // Code 1 : aucun chemin du lot n'est ignoré.
    const out = await git(repo, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...batch.map(toArg)], { okCodes: [1] });
    for (const line of out.split('\n')) {
      if (!line) continue;
      const p = unquoteGitPath(line);
      ignored.add(fromArg.get(p) ?? p);
    }
  };
  for (let i = 0; i < paths.length; i += 50) {
    const batch = paths.slice(i, i + 50);
    try {
      await check(batch);
    } catch {
      for (const p of batch) {
        try {
          await check([p]);
        } catch {
          ignored.add(p);
        }
      }
    }
  }
  return ignored;
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

// Recherche dans l'historique : commits qui ont modifié un fichier dont le chemin contient un texte.
import type { FileSearchResult } from '../shared/types';

const FILE_SEARCH_LIMIT = 5000;

/** Pathspec Git « le chemin contient <text> », insensible à la casse ; les caractères de motif sont échappés. */
export function pathContainsSpec(text: string): string {
  return `:(icase)*${text.replace(/[*?[\]\\]/g, '\\$&')}*`;
}

/** Analyse une liste de SHA séparés par NUL (`git log -z --format=%H`). */
export function parseShaList(out: string): string[] {
  return out
    .split('\0')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Arguments de `git log` pour la recherche par fichier (dépôt non vide). */
export function fileSearchArgs(text: string): string[] {
  // Mêmes révisions que `log()` pour que les résultats correspondent aux commits du graphe.
  // `--full-history` : sans lui, une branche fusionnée sans effet sur le fichier (`-s ours`…) est élaguée.
  return [
    'log',
    '-z',
    '--format=%H',
    '--full-history',
    `--max-count=${FILE_SEARCH_LIMIT}`,
    '--branches',
    '--remotes',
    '--tags',
    'HEAD',
    '--',
    pathContainsSpec(text),
  ];
}

export async function searchCommitsByPath(repo: string, text: string): Promise<FileSearchResult> {
  const needle = text.trim();
  if (!needle) return { shas: [], truncated: false };
  const head = await headSha(repo);
  // Dépôt vide : aucun commit, et `git log` échouerait.
  if (head === null) return { shas: [], truncated: false };
  const out = await git(repo, fileSearchArgs(needle));
  const shas = parseShaList(out);
  return { shas, truncated: shas.length >= FILE_SEARCH_LIMIT };
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

// Champs de `for-each-ref refs/tags` lus par `parseTags` ; chaque enregistrement se termine par TAG_RS
// (le sujet est déjà ramené sur une ligne par git, le séparateur protège seulement l'analyse).
const TAG_FIELDS = ['%(refname:lstrip=2)', '%(objecttype)', '%(objectname)', '%(*objectname)', '%(*objecttype)', '%(contents:subject)', '%(creatordate:unix)'];
const TAG_RS = '\x1e';
const TAGS_ARGS = ['for-each-ref', '--sort=-creatordate', `--format=${TAG_FIELDS.join(FS)}${TAG_RS}`, 'refs/tags'];

/** Analyse la sortie de `TAGS_ARGS` : sha = commit pointé (déréférencé pour un tag annoté), null sinon. */
export function parseTags(out: string): Tag[] {
  const tags: Tag[] = [];
  for (const rec of out.split(TAG_RS)) {
    const line = rec.replace(/^\n/, '');
    if (!line) continue;
    const [name, type, sha, derefSha, derefType, subject, date] = line.split(FS);
    const annotated = type === 'tag';
    tags.push({
      name,
      sha: annotated ? (derefType === 'commit' ? derefSha : null) : type === 'commit' ? sha : null,
      annotated,
      subject: annotated ? (subject ?? '') : '',
      date: Number(date) || 0,
    });
  }
  return tags;
}

/**
 * Combine `git remote` (tous les noms, y compris un remote sans URL) et `git remote -v` (`nom\turl (fetch|push)`).
 * L'URL peut contenir des espaces : seul le suffixe final est retiré. Ordre de `git remote` ; première URL retenue.
 * Ce sont des URL effectives (après réécriture `insteadOf`) : pour les modifier, relire les valeurs brutes
 * (`git config --get-all remote.<nom>.url` / `pushurl`). `git remote -v` répète l'URL de fetch sur la ligne
 * `(push)` sans `pushurl` : `pushUrl` vaut donc `null` quand elle est identique à `fetchUrl`.
 */
export function parseRemotes(names: string, verbose: string): Remote[] {
  const remotes = new Map<string, Remote>();
  for (const name of names.split('\n')) if (name) remotes.set(name, { name, fetchUrl: null, pushUrl: null });
  for (const line of verbose.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const r = remotes.get(line.slice(0, tab));
    const m = /^(.*) \((fetch|push)\)$/.exec(line.slice(tab + 1));
    if (!r || !m || !m[1]) continue;
    if (m[2] === 'fetch') r.fetchUrl ??= m[1];
    else r.pushUrl ??= m[1];
  }
  for (const r of remotes.values()) if (r.pushUrl === r.fetchUrl) r.pushUrl = null;
  return [...remotes.values()];
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
  const [commits, br, tagsOut, remotesOut, remotesVerbose, st, stashList] = await Promise.all([
    log(repo, head !== null),
    branches(repo),
    git(repo, TAGS_ARGS),
    git(repo, ['remote']),
    git(repo, ['remote', '-v']),
    status(repo),
    stashes(repo),
  ]);
  return {
    path: repo,
    name: basename(repo),
    commits,
    branches: br,
    tags: parseTags(tagsOut),
    remotes: parseRemotes(remotesOut, remotesVerbose),
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

// --- Historique d'un fichier et blame ---

import type { Blame, BlameCommit, BlameLine, FileRevision } from '../shared/types';

const RS = '\x1e';
export const FILE_LOG_PAGE = 200;
/** Format de l'historique d'un fichier : chaque commit commence par \x1e, le sujet (qui peut contenir \x1f) est en dernier. */
const FILE_LOG_FORMAT = '%x1e' + ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f');

/**
 * Analyse `git log --follow -z --name-status` au format FILE_LOG_FORMAT.
 * `path` sert pour les commits sans ligne de statut (fusions) : on reprend alors le chemin connu le plus récent.
 */
export function parseFileLog(out: string, path: string): FileRevision[] {
  const revisions: FileRevision[] = [];
  let current = path;
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const end = rec.indexOf('\0');
    const header = end === -1 ? rec : rec.slice(0, end);
    const fields = header.split(FS);
    const [sha, parents, author, email, date] = fields;
    const subject = fields.slice(5).join(FS);
    const files = parseNameStatus(end === -1 ? '' : rec.slice(end + 1).replace(/^\n/, ''));
    // Avec --follow, git ne garde que le fichier suivi ; par prudence on prend l'entrée qui correspond au chemin courant.
    const file = files.find((f) => f.path === current) ?? files[0];
    const rev: FileRevision = {
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      subject,
      path: file?.path ?? current,
      status: file?.status ?? 'M',
    };
    if (file?.oldPath) rev.oldPath = file.oldPath;
    revisions.push(rev);
    // Les commits plus anciens connaissent le fichier sous son ancien nom.
    current = file?.oldPath ?? rev.path;
  }
  return revisions;
}

/** Vérifie que le fichier a un historique : sans révision, il faut une HEAD. */
async function historyRev(repo: string, rev: string | null): Promise<string> {
  if (rev !== null) {
    assertSha(rev);
    return rev;
  }
  const head = await headSha(repo);
  if (!head) throw new GitError('Aucun historique : dépôt vide.', '');
  return head;
}

/**
 * Versions d'un fichier depuis `rev`.
 * Attention : avec --follow, `skip` compte les commits parcourus depuis `rev`, pas les versions du fichier.
 * Page suivante : `rev` = SHA de la dernière version chargée, `path` = son `oldPath ?? path`, `skip` = 1 (saute ce commit).
 * `limit` ne sert qu'aux tests (le rendu ne le passe pas).
 */
export async function fileLog(repo: string, path: string, rev: string | null, skip: number, limit = FILE_LOG_PAGE): Promise<FileRevision[]> {
  if (!path) throw new GitError('Aucun fichier indiqué.', '');
  const start = await historyRev(repo, rev);
  const n = Math.max(0, Math.floor(Number(skip) || 0));
  const max = Math.min(FILE_LOG_PAGE, Math.max(1, Math.floor(Number(limit) || FILE_LOG_PAGE)));
  const out = await git(repo, [
    'log',
    '--follow',
    '-M',
    '-z',
    '--name-status',
    `--format=${FILE_LOG_FORMAT}`,
    `--skip=${n}`,
    `--max-count=${max}`,
    '--end-of-options',
    start,
    '--',
    path,
  ]);
  return parseFileLog(out, path);
}

const BLAME_HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/;

/** Analyse `git blame --porcelain` : les métadonnées d'un commit ne sont données qu'à sa première apparition. */
export function parseBlame(out: string): Blame {
  const commits: Record<string, BlameCommit> = {};
  const lines: BlameLine[] = [];
  let entry: { sha: string; origLine: number; line: number } | null = null;
  for (const raw of out.split('\n')) {
    if (entry) {
      // Le contenu de la ligne est toujours précédé d'une tabulation ; tout le reste est une métadonnée.
      if (raw.startsWith('\t')) {
        lines.push({ ...entry, text: raw.slice(1) });
        entry = null;
        continue;
      }
      const sp = raw.indexOf(' ');
      const key = sp === -1 ? raw : raw.slice(0, sp);
      const value = sp === -1 ? '' : raw.slice(sp + 1);
      const c = commits[entry.sha];
      if (key === 'author') c.author = value;
      else if (key === 'author-mail') c.email = value.replace(/^<(.*)>$/, '$1');
      else if (key === 'author-time') c.date = Number(value);
      else if (key === 'summary') c.summary = value;
      continue;
    }
    const m = raw.match(BLAME_HEADER);
    if (!m) continue;
    entry = { sha: m[1], origLine: Number(m[2]), line: Number(m[3]) };
    commits[m[1]] ??= { sha: m[1], author: '', email: '', date: 0, summary: '' };
  }
  return { commits, lines };
}

export async function blame(repo: string, path: string, rev: string | null): Promise<Blame> {
  if (!path) throw new GitError('Aucun fichier indiqué.', '');
  if (rev === null && !(await headSha(repo))) throw new GitError('Aucun historique : dépôt vide.', '');
  if (rev !== null) assertSha(rev);
  try {
    return parseBlame(await git(repo, ['blame', '--porcelain', ...(rev ? [rev] : []), '--', path]));
  } catch (e) {
    if (e instanceof GitError && /no such path|cannot stat|Cannot lstat|does not exist/i.test(e.stderr)) {
      throw new GitError(
        rev ? `« ${path} » n'existe pas dans le commit ${rev.slice(0, 7)}.` : `« ${path} » n'est pas suivi par Git ou n'existe plus : blame impossible.`,
        e.stderr,
      );
    }
    throw e;
  }
}

/** Chemins d'un fichier pour un diff : l'ancien chemin d'un renommage est inclus pour que git le détecte. */
const diffPaths = (t: { path: string; oldPath?: string }) => (t.oldPath ? [t.oldPath, t.path] : [t.path]);

/**
 * Options de sortie imposées à tout diff, quelle que soit la configuration de l'utilisateur :
 * le texte doit rester analysable et réapplicable par `git apply` (préfixes a/ b/ pour -p1, pas de couleur,
 * pas d'outil externe ni de textconv qui produiraient un contenu différent du fichier réel).
 */
const DIFF_OUTPUT = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

export async function diff(repo: string, t: DiffTarget): Promise<string> {
  if (t.kind === 'commit') {
    const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', '--end-of-options', t.sha, '--'])).trim().split(' ').slice(1);
    if (parents.length === 0) return git(repo, ['show', '--format=', '-M', ...DIFF_OUTPUT, '--end-of-options', t.sha, '--', ...diffPaths(t)]);
    return git(repo, ['diff', '-M', ...DIFF_OUTPUT, '--end-of-options', parents[0], t.sha, '--', ...diffPaths(t)]);
  }
  if (t.untracked) {
    return git(repo, ['diff', '--no-index', ...DIFF_OUTPUT, '--', '/dev/null', t.path], { okCodes: [1] });
  }
  return git(repo, ['diff', '-M', ...DIFF_OUTPUT, ...(t.staged ? ['--cached'] : []), '--', ...diffPaths(t)]);
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

import type { PatchAction, PatchSelection } from '../shared/types';
import { buildPartialPatch, PatchError } from '../shared/patch';

/** Indexe, désindexe ou annule une partie du diff affiché d'un fichier du répertoire de travail. */
export async function applyPatchSelection(repo: string, t: DiffTarget, shown: string, sel: PatchSelection, action: PatchAction) {
  if (!['stage', 'unstage', 'discard'].includes(action)) throw new GitError(`Action inconnue : « ${String(action)} ».`, '');
  if (!Array.isArray(sel)) throw new GitError('Sélection invalide.', '');
  if (t.kind !== 'working' || t.untracked || t.conflict) throw new GitError('Ce fichier ne peut être traité qu\'en entier.', '');
  if (t.oldPath) throw new GitError('Fichier renommé : indexez ou désindexez le fichier entier.', '');
  if (t.staged !== (action === 'unstage')) throw new GitError(action === 'unstage' ? 'Ce diff n\'est pas indexé.' : 'Ce diff est déjà indexé.', '');
  // Le patch est reconstruit à partir du diff actuel, qui doit être celui que l'utilisateur a vu.
  const raw = await diff(repo, t);
  if (raw !== shown) throw new GitError('Le fichier a changé depuis l\'affichage, recommencez.', '');
  let patch: string;
  try {
    patch = buildPartialPatch(raw, sel, action !== 'stage');
  } catch (e) {
    throw e instanceof PatchError ? new GitError(e.message, '') : e;
  }
  const args = ['apply', '-p1', ...(action === 'discard' ? [] : ['--cached']), ...(action === 'stage' ? [] : ['--reverse']), '--recount', '--whitespace=nowarn', '-'];
  await git(repo, args, { input: patch });
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
  else if (state === 'rebasing') {
    // Commit devenu vide : Continuer le retire, ses lignes de groupe (exec de message…) ne doivent pas suivre.
    if (await indexMatchesHead(repo)) await dropOrphanedRebaseGroup(repo);
    await git(repo, ['rebase', '--continue']);
  } else if (state === 'cherry-picking') await git(repo, ['cherry-pick', '--continue']);
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

// Rebase interactif. `GIT_SEQUENCE_EDITOR` est la seule commande que Git exécute via un shell : chaîne constante,
// la liste d'instructions et les messages passent par des fichiers de `<gitDir>/arbor-rebase/`.

const REBASE_SEQUENCE_EDITOR = 'cp "$ARBOR_REBASE_TODO"';
/** Au-delà, le planificateur refuse (liste illisible, rebase très long). */
export const REBASE_MAX_COMMITS = 500;

/** Rebase en cours de lancement : le dossier ne doit pas être supprimé par un `status` concurrent. */
const rebaseStarting = new Set<string>();

async function rebaseScratchDir(repo: string, knownGitDir?: string): Promise<string> {
  return join(knownGitDir ?? (await gitDir(repo)), 'arbor-rebase');
}

/**
 * Supprime `<gitDir>/arbor-rebase/` hors rebase (terminé, abandonné, y compris après un redémarrage d'Arbor pendant
 * un arrêt), sauf pendant le lancement. Appelé par `status` quand l'état n'est pas « rebasing ».
 */
async function cleanupRebaseScratch(repo: string, knownGitDir?: string) {
  if (rebaseStarting.has(repo)) return;
  const dir = await rebaseScratchDir(repo, knownGitDir);
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Index et arbre de travail (fichiers suivis) identiques à HEAD, sans conflit. */
async function indexMatchesHead(repo: string): Promise<boolean> {
  const out = await git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no']);
  return out.length === 0;
}

/**
 * Rebase lancé par Arbor, commit d'arrêt qui ne sera pas créé (Passer, commit devenu vide) : retire de
 * `rebase-merge/git-rebase-todo` les lignes de son groupe (fixup suivants, exec du message), qui sinon
 * s'appliqueraient au commit précédent.
 */
async function dropOrphanedRebaseGroup(repo: string) {
  const dir = await gitDir(repo);
  if (!existsSync(join(dir, 'arbor-rebase'))) return;
  const merge = join(dir, 'rebase-merge');
  const todoFile = join(merge, 'git-rebase-todo');
  const [done, todo] = await Promise.all([readOptional(join(merge, 'done')), readOptional(todoFile)]);
  if (done === null || todo === null) return;
  const next = todoWithoutOrphanedGroup(done, todo, existsSync(join(merge, 'amend')));
  if (next !== null) await writeFile(todoFile, next);
}

async function assertRebaseGit(repo: string) {
  const v = parseGitVersion(await git(repo, ['version']));
  if (v && !gitVersionAtLeast(v, REBASE_MIN_GIT))
    throw new GitError(`Le rebase interactif demande Git ${REBASE_MIN_GIT.join('.')} ou plus récent (version installée : ${v.join('.')}).`, '');
}

export async function rebasePlan(repo: string, base: string, ancestorOnly: boolean): Promise<RebasePlan> {
  await assertRebaseGit(repo);
  const head = await headSha(repo);
  if (!head) throw new GitError('Dépôt vide : aucun commit à réécrire.', '');
  const st = await status(repo);
  if (st.state !== 'clean') throw new GitError('Une opération est déjà en cours : terminez-la ou abandonnez-la d\'abord.', '');
  const upstream = (
    await git(repo, ['rev-parse', '--verify', '-q', '--end-of-options', `${base}^{commit}`], { okCodes: [1] }).catch(() => '')
  ).trim();
  if (!upstream) throw new GitError(`« ${base} » ne désigne aucun commit.`, '');
  if (ancestorOnly) {
    const anc = await git(repo, ['merge-base', '--is-ancestor', upstream, head]).then(() => true, () => false);
    if (!anc) throw new GitError(`Le commit ${upstream.slice(0, 7)} n'est pas un ancêtre de HEAD.`, '');
  }
  const range = `${upstream}..${head}`;
  const merges = Number((await git(repo, ['rev-list', '--count', '--merges', range])).trim());
  if (merges > 0) throw new GitError('La plage contient des fusions : rebase interactif non pris en charge.', '');
  const count = Number((await git(repo, ['rev-list', '--count', range])).trim());
  if (count === 0) throw new GitError('Aucun commit à réécrire entre cette base et HEAD.', '');
  if (count > REBASE_MAX_COMMITS) throw new GitError(`${count} commits à réécrire : le rebase interactif est limité à ${REBASE_MAX_COMMITS}.`, '');
  const commits = parseLog(await git(repo, ['log', '-z', '--reverse', '--no-merges', `--format=${LOG_FORMAT}`, range, '--']));
  // Publiés : présents sur la branche distante suivie (aucun s'il n'y en a pas).
  const hasUpstream = (await git(repo, ['rev-parse', '--verify', '-q', '@{u}'], { okCodes: [1, 128] }).catch(() => '')).trim() !== '';
  const unpublished = hasUpstream ? new Set((await git(repo, ['rev-list', range, '--not', '@{u}'])).split(/\s+/).filter(Boolean)) : null;
  return {
    upstream,
    onto: upstream,
    head,
    branch: st.branch,
    commits: commits.map((c) => ({ ...c, published: unpublished ? !unpublished.has(c.sha) : false })),
    dirty: st.staged.length > 0 || st.unstaged.some((f) => f.status !== '?'),
  };
}

export async function rebaseInteractive(repo: string, upstream: string, expectedHead: string, steps: RebaseStep[]): Promise<'done' | 'stopped'> {
  assertSha(upstream);
  const plan = await rebasePlan(repo, upstream, false);
  if (plan.head !== expectedHead) throw new GitError('HEAD a changé depuis l\'ouverture du rebase interactif : rouvrez-le.', '');
  const expected = new Set(plan.commits.map((c) => c.sha));
  if (steps.length !== expected.size || !steps.every((s) => expected.has(s.sha)))
    throw new GitError('Les commits à réécrire ont changé : rouvrez le rebase interactif.', '');
  if (plan.dirty) throw new GitError('Des modifications locales sont en cours : commitez-les ou mettez-les de côté (stash) avant le rebase.', '');
  // Seuls les champs attendus, et les sujets relus dans le dépôt (pas ceux du rendu).
  const subjects = new Map(plan.commits.map((c) => [c.sha, c.subject]));
  const clean: RebaseStep[] = steps.map((s) => ({
    sha: s.sha,
    action: s.action,
    ...(typeof s.message === 'string' ? { message: s.message } : {}),
    subject: subjects.get(s.sha),
  }));
  const invalid = validateSteps(clean);
  if (invalid) throw new GitError(invalid, '');
  const { todo, messages } = buildTodo(clean);

  const dir = await rebaseScratchDir(repo);
  rebaseStarting.add(repo);
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const todoFile = join(dir, 'todo');
    await writeFile(todoFile, todo);
    await Promise.all(messages.map((m, i) => writeFile(join(dir, `msg-${i}`), m)));
    // Actions choisies, pour afficher reword/squash dans les étapes restantes (le todo n'a que pick/fixup).
    await writeFile(join(dir, 'actions.json'), JSON.stringify(Object.fromEntries(clean.map((s) => [s.sha, s.action]))));
    try {
      await git(
        repo,
        [
          '-c', 'rebase.updateRefs=false',
          '-c', 'rebase.missingCommitsCheck=ignore',
          '-c', 'rebase.abbreviateCommands=false',
          'rebase', '-i', '--reapply-cherry-picks', '--no-autosquash', '--end-of-options', upstream,
        ],
        { env: { GIT_SEQUENCE_EDITOR: REBASE_SEQUENCE_EDITOR, ARBOR_REBASE_TODO: todoFile } },
      );
    } catch (e) {
      if (e instanceof GitError && /execution failed|Execution failed/.test(e.stderr) && !/CONFLICT|could not apply/.test(e.stderr))
        throw new GitError('Un message n\'a pas pu être appliqué (hook commit-msg ?) : corrigez avec « Modifier le dernier commit » puis Continuer.', e.stderr);
      throw e;
    }
  } finally {
    rebaseStarting.delete(repo);
    if ((await repoState(repo).catch(() => 'clean')) !== 'rebasing') await cleanupRebaseScratch(repo);
  }
  return (await repoState(repo)) === 'rebasing' ? 'stopped' : 'done';
}

export async function skipOp(repo: string) {
  const state = await repoState(repo);
  if (state === 'rebasing') {
    await dropOrphanedRebaseGroup(repo);
    await git(repo, ['rebase', '--skip']);
  } else if (state === 'cherry-picking') await git(repo, ['cherry-pick', '--skip']);
  else if (state === 'reverting') await git(repo, ['revert', '--skip']);
  else if (state === 'merging') throw new GitError('Une fusion ne peut pas être passée : continuez-la ou abandonnez-la.', '');
}

const readOptional = (file: string) => fsReadFile(file, 'utf8').catch(() => null);

/** Progression du rebase en cours (`rebase-merge/` ou, pour l'ancien moteur, `rebase-apply/`). */
export async function rebaseProgress(repo: string, conflicted: number, clean = false, knownGitDir?: string): Promise<RebaseProgress | null> {
  const dir = knownGitDir ?? (await gitDir(repo));
  const merge = join(dir, 'rebase-merge');
  if (existsSync(merge)) {
    const [done, todo, stopped, headName, onto, actionsJson] = await Promise.all(
      [...['done', 'git-rebase-todo', 'stopped-sha', 'head-name', 'onto'].map((f) => join(merge, f)), join(dir, 'arbor-rebase', 'actions.json')].map(readOptional),
    );
    let actions: Record<string, string> | undefined;
    try {
      const parsed: unknown = actionsJson ? JSON.parse(actionsJson) : undefined;
      if (parsed && typeof parsed === 'object') actions = parsed as Record<string, string>;
    } catch {
      // fichier illisible : actions techniques
    }
    const p = progressFromFiles(
      { done: done ?? '', todo: todo ?? '', amend: existsSync(join(merge, 'amend')), stoppedSha: stopped?.trim() || null, clean, actions },
      conflicted,
    );
    // Sujets absents des fichiers (liste écrite par un autre outil, SHA abrégés) : relus dans le dépôt.
    if (p.stopped && !p.stopped.subject) {
      p.stopped.subject = (await git(repo, ['log', '-1', '--format=%s', '--end-of-options', p.stopped.sha], { okCodes: [128] }).catch(() => '')).trim();
    }
    const name = headName?.trim() ?? '';
    return {
      ...p,
      interactive: existsSync(join(merge, 'interactive')),
      headName: name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : null,
      onto: onto?.trim() ?? '',
    };
  }
  const apply = join(dir, 'rebase-apply');
  if (!existsSync(apply)) return null;
  const [next, last, headName, onto] = await Promise.all(['next', 'last', 'head-name', 'onto'].map((f) => readOptional(join(apply, f))));
  const name = headName?.trim() ?? '';
  return {
    interactive: false,
    step: Number(next?.trim()) || 0,
    total: Number(last?.trim()) || 0,
    headName: name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : null,
    onto: onto?.trim() ?? '',
    stopped: null,
    reason: conflicted > 0 ? 'conflict' : 'other',
    remaining: [],
  };
}
