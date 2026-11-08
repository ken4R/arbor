import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile as fsReadFile, realpath, rename, rm, stat, unlink, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';
import type {
  Branch,
  Commit,
  ConflictVersions,
  DiffTarget,
  FileChange,
  FileStatusCode,
  MergeModel,
  Ref,
  RepoSnapshot,
  Remote,
  RepoState,
  Stash,
  Tag,
  WorkingStatus,
} from '../shared/types';
import { blocksFromMergeOutput, markerSize, normalizeConflictText, parseMergeOutput, splitLines } from '../shared/merge3';

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
}

export function git(repo: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
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
    git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']),
    repoState(repo),
  ]);
  return { ...parseStatus(out), state };
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

/**
 * Chemin absolu réel d'un fichier du dépôt. Comparaison sur les chemins réels : un lien symbolique ne doit pas
 * permettre de sortir du dépôt. Un fichier absent est résolu par son dossier parent (écriture d'un nouveau fichier).
 */
export async function safeRepoPath(repo: string, path: string): Promise<string> {
  const root = await realpath(repo);
  const target = resolvePath(root, path);
  let full: string;
  try {
    full = await realpath(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    full = join(await realpath(dirname(target)), basename(target));
  }
  if (!full.startsWith(root + sep)) throw new GitError('Chemin en dehors du dépôt.', '');
  return full;
}

export async function readFile(repo: string, path: string): Promise<string> {
  return fsReadFile(await safeRepoPath(repo, path), 'utf8');
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
  const state = await conflictSideState(repo); // `git am` : côtés non inversés
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

// Éditeur de fusion à trois panneaux : versions d'un fichier en conflit (étages de l'index), fusion calculée par
// `git merge-file`, enregistrement du résultat.

export interface UnmergedEntry {
  mode: string;
  sha: string;
  stage: 1 | 2 | 3; // 1 = base, 2 = « ours », 3 = « theirs »
  path: string;
}

/** Analyse `git ls-files -u -z` : `mode SP sha SP étage TAB chemin NUL`. */
export function parseUnmerged(out: string): UnmergedEntry[] {
  return out
    .split('\0')
    .filter(Boolean)
    .flatMap((rec) => {
      const tab = rec.indexOf('\t');
      if (tab < 0) return [];
      const [mode, sha, stage] = rec.slice(0, tab).split(' ');
      const n = Number(stage);
      if ((n !== 1 && n !== 2 && n !== 3) || !mode || !sha) return [];
      return [{ mode, sha, stage: n as 1 | 2 | 3, path: rec.slice(tab + 1) }];
    });
}

/** Valeur de l'attribut `filter` d'après `git check-attr -z filter -- <chemin>` (`chemin NUL filter NUL valeur NUL`) ; null si aucun. */
export function parseFilterAttr(out: string): string | null {
  const value = out.split('\0')[2];
  return value && !['unspecified', 'unset', 'set'].includes(value) ? value : null;
}

/** Au-delà, l'éditeur de fusion se replie sur la vue simple des conflits. */
const MERGE_MAX_BYTES = 1024 * 1024;
const MERGE_MAX_LINES = 20000;
const MERGE_MAX_BLOCKS = 2000;
const MERGE_LABELS = ['-L', 'ma version', '-L', 'base', '-L', 'leur version'];
/** `git merge-file` renvoie le nombre de conflits (plafonné à 127) ; au-delà, c'est une erreur. */
const MERGE_FILE_CODES = Array.from({ length: 127 }, (_, i) => i + 1);

const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');

/** Empreinte SHA-1 du contenu d'un fichier ; null s'il n'existe pas. */
async function fileHash(full: string): Promise<string | null> {
  try {
    return sha1(await fsReadFile(full));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function unmergedEntries(repo: string, path: string): Promise<UnmergedEntry[]> {
  const out = await git(repo, ['--literal-pathspecs', '--no-optional-locks', 'ls-files', '-u', '-z', '--', path]);
  return parseUnmerged(out).filter((e) => e.path === path);
}

const notInConflict = (path: string) => new GitError(`« ${path} » n'est plus en conflit : rouvrez-le depuis la liste des conflits.`, '');

/** Identité des étages d'un fichier en conflit (étage de « ma version », mode et objet de chaque étage). */
export function stagesKey(entries: UnmergedEntry[], mineStage: 2 | 3): string {
  const parts = [...entries].sort((a, b) => a.stage - b.stage).map((e) => `${e.stage}:${e.mode}:${e.sha}`);
  return `${mineStage}|${parts.join(',')}`;
}

/**
 * Identité actuelle des étages (même valeur que `ConflictVersions.stages`), sans relire ni refusionner les versions :
 * l'éditeur la compare après chaque rafraîchissement pour voir si l'opération est passée à une autre étape.
 * null si le fichier n'est plus en conflit.
 */
export async function conflictStages(repo: string, path: string): Promise<string | null> {
  const [entries, state] = await Promise.all([unmergedEntries(repo, path), conflictSideState(repo)]);
  return entries.length ? stagesKey(entries, gitSide(state, 'mine') === 'ours' ? 2 : 3) : null;
}

/**
 * État qui décide des côtés : pendant `git am` (`rebase-apply/applying`), Git n'inverse pas « ours » et « theirs »
 * comme pendant un rebase (étage 2 = ma branche, étage 3 = le patch appliqué).
 */
async function conflictSideState(repo: string): Promise<RepoState> {
  const state = await repoState(repo);
  if (state === 'rebasing' && existsSync(join(await gitDir(repo), 'rebase-apply', 'applying'))) return 'merging';
  return state;
}

/** Lance `git merge-file -p` sur trois textes écrits dans un dossier temporaire (supprimé ensuite). */
async function mergeFile(repo: string, current: string, base: string, other: string, args: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arbor-merge-'));
  try {
    const files = ['ma-version', 'base', 'leur-version'].map((n) => join(dir, n));
    await Promise.all([current, base, other].map((t, i) => fsWriteFile(files[i], t, 'utf8')));
    return await git(repo, ['merge-file', '-p', ...args, ...files], { okCodes: MERGE_FILE_CODES });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Commits d'où Git a tiré le conflit, pour le refaire avec `git merge-tree` ; null si inconnus (`git am`…). */
async function conflictCommits(repo: string, state: RepoState): Promise<string[] | null> {
  const ref = async (name: string) => (await git(repo, ['rev-parse', '-q', '--verify', `${name}^{commit}`], { okCodes: [1] })).trim() || null;
  const pick = async (head: string, reverse: boolean) => {
    const sha = await ref(head);
    const parent = sha && (await ref(`${sha}^`));
    if (!sha || !parent) return null;
    return reverse ? [`--merge-base=${sha}`, 'HEAD', parent] : [`--merge-base=${parent}`, 'HEAD', sha];
  };
  if (state === 'merging') return (await ref('MERGE_HEAD')) ? ['HEAD', 'MERGE_HEAD'] : null;
  if (state === 'cherry-picking') return pick('CHERRY_PICK_HEAD', false);
  if (state === 'reverting') return pick('REVERT_HEAD', true);
  if (state === 'rebasing') return pick('REBASE_HEAD', false);
  return null;
}

/**
 * Le fichier de l'arbre de travail est-il encore celui que Git a écrit au moment du conflit (aucune résolution
 * commencée ailleurs) ? Comparaison sans les étiquettes des marqueurs, avec `git merge-file` (style de la configuration,
 * diff3, zdiff3) puis, à défaut, `git merge-tree` (même algorithme que la fusion d'origine).
 */
async function workingIsGitOutput(repo: string, path: string, working: string, ours: string, base: string, theirs: string, state: RepoState): Promise<boolean> {
  const target = normalizeConflictText(working);
  for (const style of [[], ['--diff3'], ['--zdiff3']]) {
    try {
      if (normalizeConflictText(await mergeFile(repo, ours, base, theirs, style)) === target) return true;
    } catch {
      // style inconnu de ce Git
    }
  }
  try {
    const commits = await conflictCommits(repo, state);
    if (!commits) return false;
    const tree = (await git(repo, ['merge-tree', '--write-tree', '--no-messages', ...commits], { okCodes: [1] })).split('\n')[0].trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return false;
    return normalizeConflictText(await git(repo, ['cat-file', '--filters', `--path=${path}`, `${tree}:${path}`])) === target;
  } catch {
    return false; // Git trop ancien, renommage…
  }
}

/** Fusion de l'éditeur, du point de vue de l'utilisateur ; null si la sortie de Git n'a pas pu être analysée. */
async function editorMerge(repo: string, base: string, mine: string, theirs: string): Promise<MergeModel | null> {
  const size = markerSize([base, mine, theirs]);
  const out = await mergeFile(repo, mine, base, theirs, ['--diff3', `--marker-size=${size}`, ...MERGE_LABELS]);
  const [b, m, t] = [base, mine, theirs].map(splitLines);
  const chunks = parseMergeOutput(splitLines(out).lines, size);
  const blocks = chunks && blocksFromMergeOutput(chunks, b.lines, m.lines, t.lines);
  if (!blocks) return null;
  // Fin de ligne de ma version ; si elle n'a qu'une ligne (aucune fin de ligne), celle de la leur.
  const eol = m.lines.length > 1 || m.finalNewline || !t.lines.length ? m.eol : t.eol;
  return { blocks, eol, finalNewline: { base: b.finalNewline, mine: m.finalNewline, theirs: t.finalNewline } };
}

/**
 * Trois versions d'un fichier en conflit, du point de vue de l'utilisateur (pendant un rebase, « ma version » est
 * l'étage 3, voir `gitSide`), lues avec les filtres du dépôt (fins de ligne, encodage de l'arbre de travail), et la
 * fusion calculée par Git. Une version absente (fichier supprimé de ce côté) vaut null ; contenus vidés et `merge`
 * null pour un fichier binaire, trop gros, un sous-module, un lien symbolique ou un filtre (LFS…) : repli sur la vue simple.
 */
export async function conflictVersions(repo: string, path: string): Promise<ConflictVersions> {
  const [entries, state] = await Promise.all([unmergedEntries(repo, path), conflictSideState(repo)]);
  if (!entries.length) throw notInConflict(path);
  const mineStage = gitSide(state, 'mine') === 'ours' ? 2 : 3;
  const byStage = new Map(entries.map((e) => [e.stage, e]));
  const modes = entries.map((e) => e.mode);
  const filter = parseFilterAttr(await git(repo, ['check-attr', '-z', 'filter', '--', path]));
  const unsupported = modes.includes('160000') ? 'submodule' : modes.includes('120000') ? 'symlink' : filter ? 'filter' : undefined;
  const read = (e: UnmergedEntry | undefined): Promise<string | null> =>
    !e ? Promise.resolve(null) : unsupported ? Promise.resolve('') : git(repo, ['cat-file', '--filters', `--path=${path}`, e.sha]);
  const full = await safeRepoPath(repo, path);
  const [base, mine, theirs, working] = await Promise.all([
    read(byStage.get(1)),
    read(byStage.get(mineStage)),
    read(byStage.get(mineStage === 2 ? 3 : 2)),
    fsReadFile(full).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    }),
  ]);
  const workingHash = working === null ? null : sha1(working);
  const texts = [base, mine, theirs].filter((t): t is string => t !== null);
  // Binaire : octet nul dans les 8 premiers ko (heuristique de git) ; contenu non UTF-8 traité de même (U+FFFD).
  const binary = texts.some((t) => t.slice(0, 8000).includes('\0') || t.includes('�'));
  let tooLarge = !binary && texts.some((t) => Buffer.byteLength(t) > MERGE_MAX_BYTES || t.split('\n').length > MERGE_MAX_LINES);
  // Fins de ligne mixtes (CRLF et LF dans un même fichier) : l'éditeur normaliserait tout le fichier, repli sur la vue simple.
  const mixedEol = !binary && texts.some((t) => /\r\n/.test(t) && /(^|[^\r])\n/.test(t));
  let merge: MergeModel | null = null;
  let workingMatches = false;
  if (!unsupported && !mixedEol && !binary && !tooLarge && mine !== null && theirs !== null) {
    merge = await editorMerge(repo, base ?? '', mine, theirs);
    if (merge && merge.blocks.length > MERGE_MAX_BLOCKS) {
      tooLarge = true;
      merge = null;
    }
    if (merge && working !== null) {
      const [ours, other] = mineStage === 2 ? [mine, theirs] : [theirs, mine];
      workingMatches = await workingIsGitOutput(repo, path, working.toString('utf8'), ours, base ?? '', other, state);
    }
  }
  const blank = (t: string | null) => (t === null ? null : binary || tooLarge ? '' : t);
  return {
    base: blank(base),
    mine: blank(mine),
    theirs: blank(theirs),
    workingHash,
    binary,
    tooLarge,
    merge,
    workingMatches,
    stages: stagesKey(entries, mineStage),
    ...(unsupported || mixedEol ? { unsupported: unsupported ?? 'mixed-eol' } : {}),
  };
}

/**
 * Écrit le résultat d'une fusion dans l'arbre de travail si le fichier n'a pas changé depuis le chargement
 * (`expectedHash` = `workingHash` de `conflictVersions`, ou valeur renvoyée par l'enregistrement précédent),
 * puis l'indexe si `markResolved`. Écriture atomique (fichier temporaire du même dossier, puis renommage) ;
 * bit exécutable selon le mode de ma version dans l'index (100755). Renvoie la nouvelle empreinte.
 */
export async function saveResolution(repo: string, path: string, content: string, expectedHash: string | null, markResolved: boolean): Promise<string> {
  const [entries, state] = await Promise.all([unmergedEntries(repo, path), conflictSideState(repo)]);
  if (!entries.length) throw notInConflict(path);
  const full = await safeRepoPath(repo, path);
  const link = await lstat(resolvePath(await realpath(repo), path)).then((s) => s.isSymbolicLink(), () => false);
  if (link) throw new GitError(`« ${path} » est un lien symbolique : enregistrement refusé.`, '');
  if ((await fileHash(full)) !== expectedHash) {
    throw new GitError(`« ${path} » a été modifié hors de l'éditeur de fusion depuis son ouverture. Rechargez l'éditeur pour repartir de l'état actuel.`, '');
  }
  const mineStage = gitSide(state, 'mine') === 'ours' ? 2 : 3;
  const entry = entries.find((e) => e.stage === mineStage) ?? entries.find((e) => e.stage !== 1) ?? entries[0];
  const current = await stat(full).then((s) => s.mode & 0o777, () => 0o644);
  const readable = current & 0o444;
  const mode = entry.mode === '100755' ? current | (readable >> 2) : current & ~0o111;
  const tmp = join(dirname(full), `.${basename(full)}.arbor-${randomBytes(4).toString('hex')}`);
  try {
    await fsWriteFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    await chmod(tmp, mode);
    await rename(tmp, full);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  if (markResolved) await git(repo, ['--literal-pathspecs', 'add', '--', path]);
  return sha1(content);
}

/** Conflit suppression/modification : garde le fichier tel qu'il est dans l'arbre de travail, ou le supprime. */
export async function resolveDeletion(repo: string, path: string, keep: boolean) {
  const entries = await unmergedEntries(repo, path);
  if (!entries.length) throw notInConflict(path);
  const stages = new Set(entries.map((e) => e.stage));
  if (stages.has(2) && stages.has(3)) throw new GitError(`« ${path} » n'a été supprimé d'aucun côté.`, '');
  if (keep) {
    if ((await fileHash(await safeRepoPath(repo, path))) === null) {
      throw new GitError(`« ${path} » n'existe plus dans l'arbre de travail : impossible de le garder.`, '');
    }
    await git(repo, ['--literal-pathspecs', 'add', '--', path]);
  } else {
    await git(repo, ['--literal-pathspecs', 'rm', '-q', '--', path]);
  }
}
