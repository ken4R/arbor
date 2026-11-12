import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
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
  RepoFeatures,
  RepoSnapshot,
  Remote,
  RepoState,
  Stash,
  Tag,
  WorkingStatus,
  RemoteTag,
} from '../shared/types';
import { mkdir, writeFile } from 'node:fs/promises';
import type { RebasePlan } from '../shared/types';
import { REBASE_MIN_GIT, buildTodo, gitVersionAtLeast, parseGitVersion, progressFromFiles, todoWithoutOrphanedGroup, validateSteps, type RebaseProgress, type RebaseStep } from '../shared/rebase';
import { blocksFromMergeOutput, markerSize, normalizeConflictText, parseMergeOutput, splitLines } from '../shared/merge3';
import type { RemoteConfig } from '../shared/types';
import type { ReflogEntry, ReflogKind, UndoInfo, UndoPlan } from '../shared/types';

export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

// lfs : exécutable `git-lfs` introuvable (dépôt LFS sans git-lfs installé), sous ses différentes formes. Un filtre
// git-lfs présent mais en échec (objet introuvable, téléchargement impossible) est une autre erreur (LFS_FILTER_FAILED).
const LFS_MISSING = /git-lfs(?: [\w-]+)?: (?:\d+: )?(?:git-lfs: )?(?:command )?not found|'git-lfs' was not found on your path|git: 'lfs' is not a git command/;
const LFS_FILTER_FAILED = /external filter '?git-lfs[^\n]*'? failed|smudge filter lfs failed/;

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
  // identifiants (vague 5) : avant les entrées génériques ci-dessous

  [/Authentication failed|could not read Username|Permission denied \(publickey/, () => 'Authentification refusée par le serveur distant. Vérifiez vos identifiants ou votre clé SSH.'],
  [/Could not resolve host|Connection timed out|unable to access/, () => 'Serveur distant injoignable. Vérifiez la connexion et l\'URL du remote.'],
  [/Please tell me who you are|empty ident name/, () => 'Identité Git non configurée : définissez user.name et user.email (git config --global).'],
  [/nothing to commit|no changes added to commit/, () => 'Rien à commiter.'],
  [/Not possible to fast-forward|Need to specify how to reconcile divergent branches/, () => 'Les branches ont divergé : le pull ne peut pas avancer simplement. Fusionnez ou rebasez la branche distante.'],
  [/There is no tracking information|has no upstream branch/, () => 'Cette branche ne suit aucune branche distante.'],
  [/You have unstaged changes|cannot (?:rebase|pull with rebase): You have unstaged changes/, () => 'Des modifications non commitées empêchent l\'opération. Commitez-les ou mettez-les de côté (stash).'],
  [/patch does not apply|corrupt patch/, () => 'Le bloc ne s\'applique plus : rafraîchissez.'],
  // remotes
  [/remote (\S+) already exists/, (m) => `Le remote « ${m[1]} » existe déjà.`],
  [/No such remote:? '(.+?)'/, (m) => `Le remote « ${m[1]} » n'existe pas (il a peut-être été supprimé entre-temps).`],
  [/does not appear to be a git repository/, () => 'L\'URL du remote ne désigne pas un dépôt Git accessible.'],
  [/unable to delete '(?:refs\/tags\/)?(.+?)': remote ref does not exist/, (m) => `Le tag « ${m[1]} » n'existe pas sur le remote.`],
  [/\[rejected\].*\(already exists\)/, () => 'Un tag du même nom existe déjà sur le remote.'],
  // reflog (reset --keep)
  [/Entry '(.+?)' not uptodate\. Cannot merge/, (m) => `« ${m[1]} » a des modifications locales que ce retour en arrière écraserait : commitez-les ou mettez-les de côté (stash) avant.`],
  // Index avec des conflits sans fusion en cours (ex. stash pop) : `reset --soft` et `--keep` refusent.
  [/Cannot do a (?:soft|keep) reset in the middle of a merge/, () => 'Des conflits ne sont pas résolus : résolvez-les (ou annulez-les) avant de revenir en arrière.'],
  [/Untracked working tree file '(.+?)' would be overwritten/, (m) => `Le fichier non suivi « ${m[1]} » serait écrasé : déplacez-le, ajoutez-le ou mettez-le de côté (stash) avant.`],

  // glisser-déposer
  [/is already (?:checked out|used by worktree) at '(.+?)'/, (m) => `La branche est extraite dans un autre worktree (${m[1]}) : faites l'opération depuis ce worktree.`],

  // sous-modules
  [/transport '(\w+)' not allowed/, (m) => `Git refuse le transport « ${m[1]} » pour ce sous-module (réglage protocol.${m[1]}.allow). Arbor ne modifie pas ce réglage : si vous faites confiance à cette URL, initialisez le sous-module depuis un terminal.`],
  [/No url found for submodule path '(.+?)' in \.gitmodules/, (m) => `Aucune URL n'est déclarée pour le sous-module « ${m[1]} » dans .gitmodules.`],

  // lfs
  [LFS_MISSING, () => "git-lfs n'est pas installé (ou introuvable dans le PATH) : Git ne peut pas lire ni écrire les fichiers LFS de ce dépôt. Installez git-lfs puis relancez Arbor."],
  [LFS_FILTER_FAILED, () => "Le filtre LFS a échoué : un objet LFS est introuvable ou n'a pas pu être téléchargé. Vérifiez le remote et la connexion, puis récupérez les fichiers LFS."],
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

/**
 * Crochet d'authentification (installé par l'assistant d'identifiants) : appelé avant chaque commande, il renvoie
 * null pour les commandes locales, ou des arguments à placer devant `args` (`-c credential…`) et des variables
 * d'environnement. `done()` est appelé à la sortie du processus, réussite ou échec.
 */
export type GitAuthHook = (args: readonly string[]) => { prefixArgs: string[]; env: Record<string, string>; done(): void } | null;
let authHook: GitAuthHook | null = null;
export function setGitAuthHook(h: GitAuthHook | null) {
  authHook = h;
}

export function git(repo: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const auth = authHook?.(args) ?? null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        auth?.done();
      } catch {
        // la fin de session ne doit pas masquer le résultat de la commande
      }
    };
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        'git',
        [...(auth?.prefixArgs ?? []), ...args],
        // Le crochet ne peut pas écraser les valeurs imposées par Arbor ; `opts.env` passe en dernier.
        { cwd: repo, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...auth?.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C', ...opts.env } },
        (err, stdout, stderr) => {
          finish();
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
    } catch (e) {
      // Échec immédiat (argument ou variable contenant NUL…) : la session du crochet est fermée quand même.
      finish();
      reject(e);
      return;
    }
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

/** `config` : options `-c clé=valeur` placées avant la commande (lecture sans filtre LFS, voir `statusWithoutLfs`). */
export async function status(repo: string, config: string[] = []): Promise<WorkingStatus> {
  const [out, dir] = await Promise.all([
    git(repo, [...config, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']),
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

/**
 * Vrai si un `.gitattributes` affecte `filter=lfs` à au moins un motif. Ignore les commentaires et les définitions de
 * macro (`[attr]…`), accepte les motifs entre guillemets ; `-filter`, `!filter` ou `filter=autre` ne comptent pas.
 */
export function hasLfsAttribute(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('[attr]')) continue;
    if (line.startsWith('"')) {
      // Motif entre guillemets (peut contenir des espaces et des guillemets échappés).
      const end = line.slice(1).search(/(?<!\\)"/);
      if (end < 0) continue;
      line = line.slice(end + 2);
    } else {
      line = line.replace(/^\S+/, '');
    }
    if (line.split(/\s+/).includes('filter=lfs')) return true;
  }
  return false;
}

/** Lit un fichier texte ; null s'il n'existe pas ou n'est pas lisible. */
async function readTextOrNull(full: string): Promise<string | null> {
  return fsReadFile(full, 'utf8').catch(() => null);
}

/**
 * Dossiers Git d'un arbre de travail sans lancer `git` : `.git` dossier, ou fichier `gitdir: …` (worktree lié,
 * sous-module) suivi de son `commondir` éventuel. Liste vide si rien n'est trouvé.
 */
async function gitDirsFromFiles(repo: string): Promise<string[]> {
  const dotGit = join(repo, '.git');
  const st = await stat(dotGit).catch(() => null);
  if (!st) return [];
  if (st.isDirectory()) return [dotGit];
  const m = (await readTextOrNull(dotGit))?.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return [];
  const dir = resolvePath(repo, m[1]);
  const common = (await readTextOrNull(join(dir, 'commondir')))?.trim();
  return common ? [dir, resolvePath(dir, common)] : [dir];
}

/** Sous-modules et LFS détectés par les fichiers seulement (appelé à chaque instantané : aucun lancement de `git`). */
export async function repoFeatures(repo: string): Promise<RepoFeatures> {
  const [attributes, dirs] = await Promise.all([readTextOrNull(join(repo, '.gitattributes')), gitDirsFromFiles(repo)]);
  return {
    submodules: existsSync(join(repo, '.gitmodules')),
    lfs: (attributes !== null && hasLfsAttribute(attributes)) || dirs.some((d) => existsSync(join(d, 'lfs'))),
  };
}

export async function snapshot(repo: string): Promise<RepoSnapshot> {
  const head = await headSha(repo);
  const [commits, br, tagsOut, remotesOut, remotesVerbose, st, stashList, features] = await Promise.all([
    log(repo, head !== null),
    branches(repo),
    git(repo, TAGS_ARGS),
    git(repo, ['remote']),
    git(repo, ['remote', '-v']),
    status(repo).catch((e) => statusWithoutLfs(repo, e)),
    stashes(repo),
    repoFeatures(repo),
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
    features,
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
const DIFF_OUTPUT = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '-U3'];

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
import { parseSubmoduleChange } from '../shared/diff';

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
  // sous-modules : un gitlink (mode 160000) n'a pas de lignes à indexer partiellement.
  if (parseSubmoduleChange(raw)) throw new GitError('Sous-module : indexez ou désindexez son commit en entier.', '');
  // lfs : un pointeur partiellement indexé serait invalide. Garde par l'attribut (indépendante du texte : fichier brut
  // devenu pointeur, contexte réduit…), puis par le contenu du diff.
  const lfsFilter = parseFilterAttr(await git(repo, ['check-attr', '-z', 'filter', '--', t.path])) === 'lfs';
  if (lfsFilter || lfsPointerChange(raw)) throw new GitError('Fichier LFS : indexez ou désindexez le fichier en entier.', '');
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
async function checkRefName(repo: string, kind: 'branch' | 'tag' | 'remote', name: string) {
  // Un remote est valide si `refs/remotes/<nom>/x` l'est (même règle que `git remote add`).
  const args = kind === 'branch' ? ['--branch', name] : kind === 'tag' ? [`refs/tags/${name}`] : [`refs/remotes/${name}/x`];
  const valid = !!name && !name.startsWith('-') && (await git(repo, ['check-ref-format', ...args]).then(() => true, () => false));
  if (!valid) throw new GitError(`« ${name} » n'est pas un nom de ${kind === 'branch' ? 'branche' : kind === 'tag' ? 'tag' : 'remote'} valide.`, '');
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

// glisser-déposer : actions sur une branche qui n'est pas forcément extraite. Le rendu ne fait que proposer ;
// chaque fonction revérifie l'état du dépôt (opération en cours, branche déplacée entre-temps, worktree).

/** Refuse l'action pendant une fusion, un rebase, un cherry-pick ou un revert. */
async function requireCleanState(repo: string) {
  if ((await repoState(repo)) !== 'clean') throw new GitError("Une opération est en cours : terminez-la ou abandonnez-la d'abord.", '');
}

/** SHA actuel de `refs/heads/<branch>` (nom vérifié) ; erreur si la branche n'existe pas. */
async function localBranchSha(repo: string, branch: string): Promise<string> {
  await checkRefName(repo, 'branch', branch);
  const sha = (await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { okCodes: [1] })).trim();
  if (!sha) throw new GitError(`La branche « ${branch} » n'existe pas (ou plus) : rafraîchissez.`, '');
  return sha;
}

/** Refuse une branche extraite : dans ce dépôt (branche courante) ou dans un autre worktree. */
async function requireNotCheckedOut(repo: string, branch: string, currentHint: string) {
  const head = (await git(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [1] })).trim();
  if (head === `refs/heads/${branch}`) throw new GitError(`« ${branch} » est la branche courante : ${currentHint}`, '');
  const path = (await git(repo, ['for-each-ref', '--format=%(worktreepath)', `refs/heads/${branch}`])).trim();
  if (path) throw new GitError(`La branche est extraite dans un autre worktree (${path}) : faites l'opération depuis ce worktree.`, '');
}

/**
 * Référence complète de branche envoyée par le rendu (`refs/heads/x` ou `refs/remotes/o/x`, jamais un nom court
 * ambigu avec un tag ou une branche locale `o/x`) : nom vérifié, existence vérifiée. Renvoie son SHA et son nom court.
 */
async function branchRef(repo: string, ref: string): Promise<{ sha: string; short: string; remote: boolean }> {
  const m = /^refs\/(heads|remotes)\/(.+)$/.exec(ref);
  if (!m) throw new GitError(`« ${ref} » n'est pas une référence de branche complète.`, '');
  const remote = m[1] === 'remotes';
  const valid = !m[2].startsWith('-') && (await git(repo, ['check-ref-format', ref]).then(() => true, () => false));
  if (!valid) throw new GitError(`« ${ref} » n'est pas une référence de branche valide.`, '');
  const sha = (await git(repo, ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`], { okCodes: [1] })).trim();
  if (!sha) throw new GitError(`La branche « ${m[2]} » n'existe pas (ou plus) : rafraîchissez.`, '');
  return { sha, short: m[2], remote };
}

/**
 * Fusionne la branche `source` (référence complète) dans `target`. `checkoutFirst` faux : `target` doit être la
 * branche courante, encore au SHA affiché `expectedTarget` ; vrai : `target` (encore à `expectedTarget`) est extraite
 * d'abord. Message de fusion identique à celui de Git pour un nom court.
 */
export async function mergeInto(repo: string, target: string, expectedTarget: string, source: string, checkoutFirst: boolean) {
  assertSha(expectedTarget);
  await requireCleanState(repo);
  const src = await branchRef(repo, source);
  if (checkoutFirst) {
    const sha = await localBranchSha(repo, target);
    if (sha !== expectedTarget) throw new GitError(`La branche « ${target} » a changé depuis l'affichage : rafraîchissez.`, '');
    // `git checkout <nom>` préfère toujours refs/heads/<nom> (tag ou branche distante homonymes ignorés).
    await git(repo, ['checkout', target]);
  } else {
    await checkRefName(repo, 'branch', target);
    const head = (await git(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [1] })).trim();
    const sha = (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] })).trim();
    if (head !== `refs/heads/${target}` || sha !== expectedTarget) throw new GitError('La branche courante a changé : rafraîchissez.', '');
  }
  const dest = ['main', 'master'].includes(target) ? '' : ` into ${target}`;
  const message = `Merge ${src.remote ? 'remote-tracking branch' : 'branch'} '${src.short}'${dest}`;
  await git(repo, ['merge', '--no-edit', '-m', message, '--end-of-options', source]);
}

/** Résout une révision (nom de branche, SHA) en SHA de commit. */
async function commitSha(repo: string, rev: string): Promise<string> {
  const sha = (await git(repo, ['rev-parse', '--verify', '-q', '--end-of-options', `${rev}^{commit}`], { okCodes: [1] })).trim();
  if (!sha) throw new GitError(`« ${rev} » ne désigne aucun commit (rafraîchissez).`, '');
  return sha;
}

/**
 * Avance `branch` (non extraite) jusqu'à la branche `sourceRef` (référence complète) sans checkout, si c'est une
 * avance rapide. `expectedOld`, `expectedSource` : SHA affichés ; la mise à jour est atomique
 * (`update-ref <nouveau> <ancien>`) et inscrite au reflog.
 */
export async function fastForwardBranch(repo: string, branch: string, expectedOld: string, sourceRef: string, expectedSource: string) {
  assertSha(expectedOld);
  assertSha(expectedSource);
  await requireCleanState(repo);
  const old = await localBranchSha(repo, branch);
  if (old !== expectedOld) throw new GitError(`La branche « ${branch} » a changé depuis l'affichage : rafraîchissez.`, '');
  await requireNotCheckedOut(repo, branch, 'utilisez « Fusionner ».');
  const { sha: to, short: source } = await branchRef(repo, sourceRef);
  if (to !== expectedSource) throw new GitError(`La branche « ${source} » a changé depuis l'affichage : rafraîchissez.`, '');
  if (to === old) throw new GitError(`« ${branch} » est déjà à jour avec « ${source} ».`, '');
  const base = (await git(repo, ['merge-base', old, to], { okCodes: [1] })).trim();
  if (base === to) throw new GitError(`« ${branch} » contient déjà « ${source} ».`, '');
  if (base !== old) throw new GitError(`Pas d'avance rapide possible : « ${branch} » a des commits absents de « ${source} ». Basculez sur « ${branch} » pour fusionner.`, '');
  await git(repo, ['update-ref', '-m', `merge ${source}: Fast-forward`, `refs/heads/${branch}`, to, old]);
}

/**
 * Rebase de `branch` sur `onto` (`git rebase <onto> <branch>`) : la branche est extraite d'abord et reste extraite
 * à la fin. `onto` : SHA ou référence complète (`refs/heads/…`, `refs/remotes/…`) ; `git rebase` prend `<branch>`
 * dans refs/heads en priorité. `autostash` faux : `--no-autostash` explicite (la configuration de l'utilisateur ne décide pas).
 */
export async function rebaseBranch(repo: string, branch: string, onto: string, autostash: boolean) {
  await requireCleanState(repo);
  await localBranchSha(repo, branch);
  if (onto.startsWith('refs/')) await branchRef(repo, onto);
  else assertSha(onto);
  await git(repo, ['rebase', autostash ? '--autostash' : '--no-autostash', '--end-of-options', onto, branch]);
}

/** Pousse `refs/heads/<branch>` vers la branche du même nom sur `remote` (jamais forcé) ; `-u` si demandé. */
export async function pushBranch(repo: string, remote: string, branch: string, setUpstream: boolean) {
  await requireRemote(repo, remote);
  await localBranchSha(repo, branch);
  await git(repo, ['push', ...(setUpstream ? ['-u'] : []), '--end-of-options', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
}

/**
 * Déplace `branch` (non extraite) sur le commit `sha`, quel qu'il soit (destructif : les commits qui ne sont plus
 * atteignables restent dans le reflog). `expectedOld` : SHA affiché.
 */
export async function moveBranch(repo: string, branch: string, expectedOld: string, sha: string) {
  assertSha(expectedOld);
  assertSha(sha);
  await requireCleanState(repo);
  const old = await localBranchSha(repo, branch);
  if (old !== expectedOld) throw new GitError(`La branche « ${branch} » a changé depuis l'affichage : rafraîchissez.`, '');
  await requireNotCheckedOut(repo, branch, 'utilisez un reset depuis le menu du commit.');
  const to = await commitSha(repo, sha);
  if (to === old) throw new GitError(`« ${branch} » pointe déjà sur ce commit.`, '');
  await git(repo, ['update-ref', '-m', 'branch: déplacée par Arbor', `refs/heads/${branch}`, to, old]);
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

/** Tag léger (`message` null) ou annoté (message sur l'entrée standard, nettoyé des espaces superflus). */
export async function createTag(repo: string, name: string, sha: string, message: string | null) {
  await checkRefName(repo, 'tag', name);
  if (message === null) {
    await git(repo, ['tag', '--end-of-options', name, sha]);
    return;
  }
  if (!message.trim()) throw new GitError("Un tag annoté a besoin d'un message.", '');
  await git(repo, ['tag', '-a', '-F', '-', '--cleanup=whitespace', '--end-of-options', name, sha], { input: message });
}

export async function cherryPick(repo: string, sha: string) {
  await git(repo, ['cherry-pick', '--end-of-options', sha]);
}

export async function revert(repo: string, sha: string) {
  await git(repo, ['revert', '--no-edit', '--end-of-options', sha]);
}

export async function reset(repo: string, sha: string, mode: 'soft' | 'mixed' | 'hard' | 'keep') {
  assertSha(sha);
  if (!['soft', 'mixed', 'hard', 'keep'].includes(mode)) throw new GitError(`Mode de reset inconnu : ${mode}.`, '');
  // Retour à un état du reflog : jamais au milieu d'une fusion ou d'un rebase (dialogue ouvert avant son début).
  if (mode === 'keep' && (await repoState(repo)) !== 'clean')
    throw new GitError('Une opération est en cours : terminez-la ou abandonnez-la avant de revenir à un état du reflog.', '');
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

// --- Remotes ---

/** Erreur de validation d'une URL de remote (vide, prise pour une option, multiligne), ou null si elle convient. */
export function remoteUrlError(url: string): string | null {
  const u = url.trim();
  if (!u) return "L'URL est vide.";
  if (u.startsWith('-')) return `« ${u} » n'est pas une URL valide.`;
  if (/[\0\n\r]/.test(u)) return "L'URL ne doit pas contenir de saut de ligne.";
  return null;
}

function checkRemoteUrl(url: string): string {
  const err = remoteUrlError(url);
  if (err) throw new GitError(err, '');
  return url.trim();
}

/** Valeurs d'une clé lue par `git config --null --get-all` (liste vide si la clé est absente). */
export function parseConfigValues(out: string): string[] {
  return out.split('\0').filter((v) => v !== '');
}

async function configValues(repo: string, key: string): Promise<string[]> {
  // Code 1 : clé absente.
  return parseConfigValues(await git(repo, ['config', '--null', '--get-all', key], { okCodes: [1] }));
}

/** Sortie de `git config --null --show-scope --get-all` : paires `portée NUL valeur NUL`. */
export function parseScopedConfigValues(out: string): { scope: string; value: string }[] {
  const parts = out.split('\0');
  const res: { scope: string; value: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) res.push({ scope: parts[i], value: parts[i + 1] });
  return res;
}

const SCOPE_LABELS: Record<string, string> = { global: 'globale', system: 'système', worktree: 'du worktree', command: 'de la ligne de commande' };

/** URL brutes d'un remote, avant réécriture par `insteadOf` : `remote.<nom>.url` et `remote.<nom>.pushurl`. */
export async function remoteConfig(repo: string, name: string): Promise<RemoteConfig> {
  await checkRefName(repo, 'remote', name);
  const [urls, pushUrls] = await Promise.all([configValues(repo, `remote.${name}.url`), configValues(repo, `remote.${name}.pushurl`)]);
  return { urls, pushUrls };
}

/** Ajoute un remote ; `pushUrl` facultative (vide = même URL que le fetch) ; `fetch` récupère ses branches aussitôt. */
export async function addRemote(repo: string, name: string, url: string, pushUrl: string | null, fetch: boolean) {
  await checkRefName(repo, 'remote', name);
  const fetchUrl = checkRemoteUrl(url);
  const push = pushUrl?.trim() ? checkRemoteUrl(pushUrl) : null;
  await git(repo, ['remote', 'add', '--', name, fetchUrl]);
  if (push) await git(repo, ['remote', 'set-url', '--push', '--', name, push]);
  if (!fetch) return;
  try {
    await fetchRemote(repo, name);
  } catch (e) {
    // Le remote reste configuré : l'utilisateur corrige l'URL ou relance le fetch.
    throw new GitError(`Remote « ${name} » ajouté, mais le fetch a échoué : ${(e as Error).message}`, e instanceof GitError ? e.stderr : '');
  }
}

export async function renameRemote(repo: string, oldName: string, newName: string) {
  await checkRefName(repo, 'remote', oldName);
  await checkRefName(repo, 'remote', newName);
  await git(repo, ['remote', 'rename', '--', oldName, newName]);
}

/** Supprime le remote, ses branches distantes et la configuration de suivi qui le référence. */
export async function removeRemote(repo: string, name: string) {
  await checkRefName(repo, 'remote', name);
  await git(repo, ['remote', 'remove', '--', name]);
}

/**
 * Change l'URL de fetch (`push` faux) ou de push d'un remote. Pour le push, `url` null ou vide retire
 * `remote.<nom>.pushurl` (le push reprend l'URL de fetch). Une seule URL par sens : URL multiples refusées.
 */
export async function setRemoteUrl(repo: string, name: string, url: string | null, push: boolean) {
  await checkRefName(repo, 'remote', name);
  const key = `remote.${name}.${push ? 'pushurl' : 'url'}`;
  const current = await configValues(repo, key);
  if (push && !url?.trim()) {
    // Une pushurl venue d'un autre niveau (globale, système…) survivrait au retrait local : on refuse.
    const scoped = parseScopedConfigValues(await git(repo, ['config', '--null', '--show-scope', '--get-all', key], { okCodes: [1] }));
    const other = scoped.find((v) => v.scope !== 'local');
    if (other) throw new GitError(`L'URL de push vient de la configuration ${SCOPE_LABELS[other.scope] ?? other.scope} : modifiez-la là-bas.`, '');
    // Code 5 : clé déjà absente (supprimée entre-temps).
    if (scoped.length) await git(repo, ['config', '--local', '--unset-all', key], { okCodes: [5] });
    return;
  }
  const value = checkRemoteUrl(url ?? '');
  if (current.length > 1) throw new GitError('Ce remote a plusieurs URL configurées : modification non prise en charge (utilisez git config).', '');
  await git(repo, ['remote', 'set-url', ...(push ? ['--push'] : []), '--', name, value]);
}

/** Fetch d'un seul remote ; les branches distantes disparues sont retirées. */
export async function fetchRemote(repo: string, name: string) {
  await checkRefName(repo, 'remote', name);
  await git(repo, ['fetch', '--prune', '--end-of-options', name]);
}

/** Retire les branches distantes qui n'existent plus sur le remote, sans rien récupérer. */
export async function pruneRemote(repo: string, name: string) {
  await checkRefName(repo, 'remote', name);
  await git(repo, ['remote', 'prune', '--', name]);
}

// Tags : suppression, publication, liste distante.

/** Refuse un tag absent du dépôt local (nom vérifié par `check-ref-format`). */
async function requireLocalTag(repo: string, name: string) {
  await checkRefName(repo, 'tag', name);
  const sha = (await git(repo, ['rev-parse', '--verify', '-q', `refs/tags/${name}`], { okCodes: [1] })).trim();
  if (!sha) throw new GitError(`Le tag « ${name} » n'existe pas (ou plus) : rafraîchissez.`, '');
}

/** Refuse un remote qui n'est pas configuré (une URL passée à la place d'un nom, par exemple). */
async function requireRemote(repo: string, remote: string) {
  const names = (await git(repo, ['remote'])).split('\n').filter(Boolean);
  if (!names.includes(remote)) throw new GitError(`Le remote « ${remote} » n'existe pas.`, '');
}

export async function deleteTag(repo: string, name: string) {
  await requireLocalTag(repo, name);
  await git(repo, ['tag', '-d', '--end-of-options', name]);
}

/** Checkout (HEAD détachée) d'un tag par son nom complet `refs/tags/<nom>` : jamais ambigu avec une branche homonyme. */
export async function checkoutTag(repo: string, name: string) {
  await requireLocalTag(repo, name);
  await git(repo, ['checkout', '--detach', `refs/tags/${name}`]);
}

export async function deleteRemoteTag(repo: string, remote: string, name: string) {
  await checkRefName(repo, 'tag', name);
  // `git push --delete` réussit même si le tag est absent du remote : on vérifie d'abord sa présence.
  if (!(await remoteTags(repo, remote)).some((t) => t.name === name)) throw new GitError(`Le tag « ${name} » n'existe pas sur ${remote}.`, '');
  await git(repo, ['push', '--delete', '--end-of-options', remote, `refs/tags/${name}`]);
}

export async function pushTag(repo: string, remote: string, name: string) {
  await requireLocalTag(repo, name);
  await requireRemote(repo, remote);
  await git(repo, ['push', '--end-of-options', remote, `refs/tags/${name}`]);
}

export async function pushAllTags(repo: string, remote: string) {
  await requireRemote(repo, remote);
  await git(repo, ['push', '--tags', '--end-of-options', remote]);
}

/**
 * Analyse `git ls-remote --tags --refs` (`<sha>\trefs/tags/<nom>`) : noms et objets pointés, dans l'ordre reçu.
 * Les entrées déréférencées (`^{}`) et les lignes inattendues sont ignorées.
 */
export function parseLsRemoteTags(out: string): RemoteTag[] {
  const tags: RemoteTag[] = [];
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const sha = line.slice(0, tab).trim();
    const ref = line.slice(tab + 1).replace(/\r$/, '');
    if (!SHA_RE.test(sha) || !ref.startsWith('refs/tags/') || ref.endsWith('^{}')) continue;
    const name = ref.slice('refs/tags/'.length);
    if (name) tags.push({ name, sha });
  }
  return tags;
}

/** Tags présents sur un remote (accès réseau, à la demande). */
export async function remoteTags(repo: string, remote: string): Promise<RemoteTag[]> {
  await requireRemote(repo, remote);
  return parseLsRemoteTags(await git(repo, ['ls-remote', '--tags', '--refs', '--end-of-options', remote]));
}

// Reflog : liste des états successifs d'une référence et annulation de la dernière opération de la branche.

/** Entrées du reflog par page (dialogue du reflog). */
export const REFLOG_PAGE = 200;
/** Avec `--date=unix`, `%gd` vaut `ref@{<date de l'opération>}` : la position est recalculée à partir de `--skip`. */
const REFLOG_FORMAT = ['%H', '%gd', '%gs'].join(FS);

function reflogArgs(fullRef: string, skip: number, limit: number): string[] {
  return ['log', '-g', '-z', '--date=unix', `--format=${REFLOG_FORMAT}`, `--max-count=${limit}`, `--skip=${skip}`, fullRef, '--'];
}

/** Nature d'une opération d'après le message du reflog (`%gs`), y compris les formes d'anciennes versions de Git. */
export function classifyReflog(subject: string): ReflogKind {
  const s = subject.trimStart();
  if (/^commit \(amend\)/.test(s)) return 'amend';
  if (/^commit \(merge\)/.test(s)) return 'merge';
  if (/^commit \(cherry-pick\)/.test(s)) return 'cherry-pick';
  if (/^commit( \(initial\))?:/.test(s)) return 'commit';
  if (/^merge\b/.test(s)) return 'merge';
  if (/^pull\b/.test(s)) return 'pull';
  if (/^rebase\b/.test(s)) return 'rebase';
  if (/^reset:/.test(s)) return 'reset';
  if (/^cherry-pick\b/.test(s)) return 'cherry-pick';
  if (/^revert\b/.test(s)) return 'revert';
  if (/^checkout:/.test(s)) return 'checkout';
  return 'other';
}

/** Analyse la sortie de `reflogArgs` (enregistrements séparés par NUL) ; `skip` = position de la première entrée. */
export function parseReflog(out: string, ref: string, skip = 0): ReflogEntry[] {
  return out
    .split('\0')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha = '', gd = '', ...rest] = rec.split(FS);
      return { sha, gd, subject: rest.join(FS) };
    })
    .filter((r) => SHA_RE.test(r.sha))
    .map((r, i) => ({
      index: skip + i,
      selector: `${ref}@{${skip + i}}`,
      sha: r.sha,
      subject: r.subject,
      kind: classifyReflog(r.subject),
      date: Number(r.gd.match(/@\{(\d+)\}$/)?.[1] ?? 0),
    }));
}

const UNDO_LABEL_MAX = 60;

/** Message du reflog raccourci pour une confirmation. */
export function undoLabel(subject: string): string {
  const s = subject.trim();
  return s.length > UNDO_LABEL_MAX ? `${s.slice(0, UNDO_LABEL_MAX - 1).trimEnd()}…` : s;
}

/**
 * Annulation de la dernière opération de `branch` à partir des deux premières entrées de son reflog : la branche
 * revient à l'entrée 1, par `reset --soft` après un commit ou un amend (changements gardés indexés), `--keep` sinon.
 * L'entrée 0 doit être HEAD (sinon la branche a bougé sans reflog). `reason` explique un refus.
 */
export function undoPlan(entries: { sha: string; subject: string }[], head: string | null, branch: string | null): { plan: UndoPlan | null; reason: string | null } {
  const no = (reason: string) => ({ plan: null, reason });
  if (!branch) return no('HEAD détachée : seule la dernière opération d\'une branche extraite peut être annulée.');
  if (!head) return no('Dépôt vide : rien à annuler.');
  const [last, previous] = entries;
  if (!last) return no(`Le reflog de « ${branch} » est vide : rien à annuler.`);
  if (last.sha !== head) return no(`Le reflog de « ${branch} » ne correspond pas à HEAD (branche déplacée sans reflog) : annulation impossible.`);
  const label = undoLabel(last.subject);
  if (!previous) return no(`« ${label} » est le premier état de la branche : rien à annuler.`);
  const kind = classifyReflog(last.subject);
  if (kind === 'checkout' || kind === 'other') return no(`« ${label} » ne s'annule pas automatiquement : choisissez un état dans le reflog.`);
  if (previous.sha === head) return no(`« ${label} » n'a pas déplacé la branche : rien à annuler.`);
  return { plan: { kind, label, target: previous.sha, mode: kind === 'commit' || kind === 'amend' ? 'soft' : 'keep' }, reason: null };
}

/** Page du reflog de « HEAD » ou d'une branche locale ; vide si la référence n'existe pas (encore). */
export async function reflog(repo: string, ref: string, skip: number): Promise<ReflogEntry[]> {
  const from = Number.isInteger(skip) && skip > 0 ? skip : 0;
  let full = 'HEAD';
  if (ref !== 'HEAD') {
    await checkRefName(repo, 'branch', ref);
    full = `refs/heads/${ref}`;
  }
  if (!(await git(repo, ['rev-parse', '--verify', '-q', full], { okCodes: [1] })).trim()) return [];
  return parseReflog(await git(repo, reflogArgs(full, from, REFLOG_PAGE)), ref, from);
}

export async function undoInfo(repo: string): Promise<UndoInfo> {
  const [st, head] = await Promise.all([status(repo), headSha(repo)]);
  const base = { branch: st.branch, head };
  if (st.state !== 'clean') return { ...base, plan: null, reason: 'Une opération est en cours : terminez-la ou abandonnez-la d\'abord.' };
  if (st.conflicted.length) return { ...base, plan: null, reason: 'Des conflits ne sont pas résolus : résolvez-les (ou annulez-les) avant de revenir en arrière.' };
  const entries = st.branch && head ? parseReflog(await git(repo, reflogArgs(`refs/heads/${st.branch}`, 0, 2)), st.branch) : [];
  return { ...base, ...undoPlan(entries, head, st.branch) };
}

/** Annule la dernière opération de la branche extraite, si elle est toujours celle affichée (HEAD et cible). */
export async function undoLast(repo: string, expectedHead: string, expectedTarget: string) {
  const info = await undoInfo(repo);
  if (!info.plan) throw new GitError(info.reason ?? 'Rien à annuler.', '');
  if (info.head !== expectedHead || info.plan.target !== expectedTarget)
    throw new GitError('La branche a changé depuis l\'affichage : relancez Annuler pour voir la dernière opération.', '');
  await reset(repo, info.plan.target, info.plan.mode);
}

// sous-modules
// Trois lancements de `git` au plus pour l'état de tous les sous-modules, tous dans le dépôt parent. On ne lance
// jamais `git` dans le dossier d'un sous-module sans `<chemin>/.git` : Git remonterait jusqu'au dépôt parent.

import type { Submodule, SubmoduleState } from '../shared/types';

/** Entrée de `.gitmodules`. */
export interface GitmodulesEntry {
  name: string;
  path: string;
  url: string | null;
  branch: string | null;
}

/**
 * Analyse `git config -z -f .gitmodules --get-regexp '^submodule\.'` : enregistrements `clé\nvaleur\0`. Le nom est
 * entre `submodule.` et le dernier point (il peut contenir des points). Dernière valeur gagnante, comme Git ; entrées
 * sans `path` (ou à chemin refusé) écartées ; un chemin déjà déclaré par un autre nom est ignoré.
 */
export function parseGitmodules(out: string): GitmodulesEntry[] {
  const PREFIX = 'submodule.';
  const byName = new Map<string, { path?: string; url?: string; branch?: string }>();
  for (const rec of out.split('\0')) {
    if (!rec.startsWith(PREFIX)) continue;
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    const dot = key.lastIndexOf('.');
    if (dot <= PREFIX.length) continue; // pas de nom
    const name = key.slice(PREFIX.length, dot);
    const variable = key.slice(dot + 1).toLowerCase();
    const entry = byName.get(name) ?? {};
    byName.set(name, entry);
    if (nl < 0) continue; // booléen sans valeur
    const value = rec.slice(nl + 1);
    if (variable === 'path' || variable === 'url' || variable === 'branch') entry[variable] = value;
  }
  const seen = new Set<string>();
  const result: GitmodulesEntry[] = [];
  for (const [name, e] of byName) {
    const path = e.path === undefined ? null : normalizeSubmodulePath(e.path);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    result.push({ name, path, url: e.url ?? null, branch: e.branch ?? null });
  }
  return result;
}

/**
 * Chemin de sous-module relatif et sans détour (`..`, `.`, `.git`, chemin absolu, caractère de contrôle refusés) ;
 * barres finales retirées. null si le chemin est refusé : il ne doit jamais servir à construire un chemin du disque.
 */
export function normalizeSubmodulePath(raw: string): string | null {
  const path = raw.replace(/\/+$/, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || /[\0-\x1f\\]/.test(path)) return null;
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')) return null;
  return path;
}

/** Entrée de `git ls-files -s -z` : `mode SP sha SP étage TAB chemin NUL`, étages 0 à 3. */
export interface IndexEntry {
  mode: string;
  sha: string;
  stage: 0 | 1 | 2 | 3;
  path: string;
}

export function parseLsFilesStage(out: string): IndexEntry[] {
  return out
    .split('\0')
    .filter(Boolean)
    .flatMap((rec) => {
      const tab = rec.indexOf('\t');
      if (tab < 0) return [];
      const [mode, sha, stage] = rec.slice(0, tab).split(' ');
      const n = Number(stage);
      if (![0, 1, 2, 3].includes(n) || !mode || !sha) return [];
      return [{ mode, sha, stage: n as IndexEntry['stage'], path: rec.slice(tab + 1) }];
    });
}

/** Indicateurs d'un sous-module dans `git status --porcelain=v2` (champ `S<c><m><u>`). */
export interface SubmoduleStatusFlags {
  /** `C` : le commit extrait diffère de celui de l'index. */
  commitChanged: boolean;
  /** `M` : fichiers suivis modifiés. */
  modified: boolean;
  /** `U` : fichiers non suivis. */
  untracked: boolean;
  /** Entrée `u` (non fusionnée). */
  conflict: boolean;
}

/**
 * Analyse `git status --porcelain=v2 -z` limité aux chemins des sous-modules : `1 XY sub mH mI mW hH hI chemin`,
 * `2 … score chemin NUL origine`, `u XY sub m1 m2 m3 mW h1 h2 h3 chemin`. Seules les entrées de sous-module
 * (`sub` commençant par `S`) sont gardées, indexées par chemin.
 */
export function parseSubmoduleStatusV2(out: string): Map<string, SubmoduleStatusFlags> {
  const result = new Map<string, SubmoduleStatusFlags>();
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const kind = rec[0];
    const fields = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : 0;
    if (!fields) continue;
    if (kind === '2') i++; // chemin d'origine du renommage
    const parts = rec.split(' ');
    if (parts.length <= fields) continue;
    const sub = parts[2];
    if (!/^S[C.][M.][U.]$/.test(sub)) continue;
    const path = parts.slice(fields).join(' ');
    result.set(path, { commitChanged: sub[1] === 'C', modified: sub[2] === 'M', untracked: sub[3] === 'U', conflict: kind === 'u' });
  }
  return result;
}

/** État d'un sous-module à partir de l'index, du statut et de la présence de `<chemin>/.git`. */
export function submoduleState(input: { inIndex: boolean; conflict: boolean; initialized: boolean; flags?: SubmoduleStatusFlags }): SubmoduleState {
  if (input.conflict || input.flags?.conflict) return 'conflict';
  if (!input.inIndex) return 'missing';
  if (!input.initialized) return 'uninitialized';
  return input.flags?.commitChanged ? 'changed' : 'ok';
}

/** Assemble la liste des sous-modules à partir des sorties analysées (pur, testé). */
export function buildSubmodules(
  entries: GitmodulesEntry[],
  index: IndexEntry[],
  status: Map<string, SubmoduleStatusFlags>,
  isInitialized: (path: string) => boolean,
): Submodule[] {
  return entries.map((e) => {
    const own = index.filter((x) => x.path === e.path);
    const gitlink = own.find((x) => x.stage === 0 && x.mode === '160000');
    const conflict = own.some((x) => x.stage !== 0);
    const initialized = isInitialized(e.path);
    const flags = status.get(e.path);
    const state = submoduleState({ inIndex: !!gitlink, conflict, initialized, flags });
    return {
      ...e,
      expected: conflict ? null : (gitlink?.sha ?? null),
      initialized,
      state,
      dirty: initialized && !!flags?.modified,
      untracked: initialized && !!flags?.untracked,
    };
  });
}

/**
 * Vrai si `<chemin>` est un vrai dossier du dépôt (aucun lien symbolique sur le trajet : un lien `ext -> ../autre`
 * mènerait hors du dépôt) qui contient `.git`.
 */
function isInitializedSync(repo: string, rootReal: string | null, path: string): boolean {
  if (rootReal === null) return false;
  try {
    return realpathSync(join(repo, path)) === join(rootReal, path) && existsSync(join(repo, path, '.git'));
  } catch {
    return false;
  }
}

/** Vrai si un des éléments de `<repo>/<chemin>` (dossiers intermédiaires compris) est un lien symbolique. */
export function hasSymlinkComponent(repo: string, path: string): boolean {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    try {
      if (lstatSync(join(repo, ...parts.slice(0, i))).isSymbolicLink()) return true;
    } catch {
      return false; // absent : rien plus loin
    }
  }
  return false;
}

/**
 * Sous-modules déclarés dans `.gitmodules` (aucun lancement de `git` sans ce fichier). `changed` (facultatif, envoyé
 * par le rendu) : chemins présents dans le statut du dépôt ; le `status` des sous-modules n'est lancé que pour eux
 * (les autres sont à jour par construction), et pas du tout si aucun. Sans `changed`, tous les chemins sont lus
 * (vérifications du processus principal).
 */
export async function submodules(repo: string, changed?: unknown): Promise<Submodule[]> {
  if (!existsSync(join(repo, '.gitmodules'))) return [];
  const config = await git(repo, ['config', '-z', '-f', '.gitmodules', '--get-regexp', '^submodule\\.'], { okCodes: [1] });
  const entries = parseGitmodules(config);
  if (entries.length === 0) return [];
  // Un chemin qui passe par un lien symbolique n'est jamais confié à `git` : les versions récentes refusent toute la
  // commande (« expected submodule path '…' not to be a symbolic link »). Ces entrées restent sans index : `missing`.
  const paths = entries.map((e) => e.path).filter((p) => !hasSymlinkComponent(repo, p));
  if (paths.length === 0) return buildSubmodules(entries, [], new Map(), () => false);
  const hint = Array.isArray(changed) ? new Set(changed.filter((p): p is string => typeof p === 'string')) : null;
  const statusPaths = hint ? paths.filter((p) => hint.has(p)) : paths;
  const [ls, st] = await Promise.all([
    git(repo, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths]),
    statusPaths.length
      ? git(repo, ['--no-optional-locks', '--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--ignore-submodules=none', '--', ...statusPaths])
      : Promise.resolve(''),
  ]);
  let rootReal: string | null = null;
  try {
    rootReal = realpathSync(repo);
  } catch {
    // dépôt inaccessible : aucun sous-module initialisé
  }
  return buildSubmodules(entries, parseLsFilesStage(ls), parseSubmoduleStatusV2(st), (p) => isInitializedSync(repo, rootReal, p));
}

/** Sous-module désigné par le rendu, revérifié contre la liste recalculée. */
export async function requireSubmodule(repo: string, path: unknown): Promise<Submodule> {
  const sub = typeof path === 'string' ? (await submodules(repo)).find((s) => s.path === path) : undefined;
  if (!sub) throw new GitError(`« ${String(path)} » n'est pas un sous-module déclaré dans .gitmodules.`, '');
  return sub;
}

const notInitialized = (path: string) => new GitError(`Le sous-module « ${path} » n'est pas initialisé : initialisez-le d'abord.`, '');
const noGitlink = (path: string) => new GitError(`Aucun commit attendu pour « ${path} » (sous-module en conflit ou absent de l'index).`, '');

/**
 * Dossier d'un sous-module initialisé, avec un gitlink à l'étage 0, sans lien symbolique sur le trajet, et racine de
 * son propre dépôt (sinon Git remonterait au parent).
 */
async function verifiedRoot(repo: string, sub: Submodule): Promise<string> {
  if (sub.state === 'missing' || sub.state === 'conflict' || !sub.expected) throw noGitlink(sub.path);
  if (!sub.initialized) throw notInitialized(sub.path);
  const dir = join(repo, sub.path);
  const invalid = new GitError(`Le dossier « ${sub.path} » n'est pas un dépôt Git valide.`, '');
  const real = await realpath(dir).catch(() => null);
  if (real === null || real !== join(await realpath(repo), sub.path)) throw invalid;
  const top = await toplevel(dir).catch(() => null);
  if (top === null || (await realpath(top)) !== real) throw invalid;
  return dir;
}

export async function submoduleRoot(repo: string, path: unknown): Promise<string> {
  return verifiedRoot(repo, await requireSubmodule(repo, path));
}

export async function submoduleHead(repo: string, path: unknown): Promise<string | null> {
  const sub = await requireSubmodule(repo, path);
  if (!sub.initialized) return null;
  return headSha(await verifiedRoot(repo, sub));
}

/**
 * Initialise les sous-modules non initialisés : celui de `path`, ou tous (liste explicite) si `path` est null.
 * Toujours `--checkout` : jamais de rebase ni de fusion selon `submodule.<nom>.update`. Un sous-module déjà
 * initialisé n'est jamais déplacé (un « autre commit extrait » se traite par « Revenir au commit attendu… »).
 */
export async function submoduleInit(repo: string, path: unknown) {
  let targets: string[];
  if (path === null) {
    targets = (await submodules(repo)).filter((s) => s.state === 'uninitialized').map((s) => s.path);
    if (!targets.length) throw new GitError('Aucun sous-module à initialiser.', '');
  } else {
    const sub = await requireSubmodule(repo, path);
    if (sub.state === 'changed')
      throw new GitError(`« ${sub.path} » a un autre commit extrait : utilisez « Revenir au commit attendu… » pour le ramener au commit attendu.`, '');
    if (sub.state === 'missing' || sub.state === 'conflict') throw noGitlink(sub.path);
    if (sub.state !== 'uninitialized') throw new GitError(`Le sous-module « ${sub.path} » est déjà initialisé.`, '');
    targets = [sub.path];
  }
  await git(repo, ['--literal-pathspecs', 'submodule', 'update', '--init', '--checkout', '--recursive', '--', ...targets]);
}

/**
 * Revient au commit attendu `expected` (celui affiché) : checkout forcé (`--checkout`), sans les sous-modules
 * imbriqués ; refusé si le gitlink a changé depuis l'affichage.
 */
export async function submoduleReset(repo: string, path: unknown, expected: unknown) {
  const sub = await requireSubmodule(repo, path);
  if (!sub.expected || sub.state === 'missing' || sub.state === 'conflict') throw noGitlink(sub.path);
  if (sub.expected !== expected) throw new GitError('Le commit attendu a changé : rafraîchissez.', '');
  await verifiedRoot(repo, sub);
  await git(repo, ['--literal-pathspecs', 'submodule', 'update', '--checkout', '--', sub.path]);
}

export async function submoduleSync(repo: string) {
  await git(repo, ['submodule', 'sync', '--recursive']);
}

// lfs
// git-lfs est facultatif : sans lui, les motifs viennent du `.gitattributes` racine et les actions sont refusées.
// `git lfs ls-files` n'est jamais appelé par `snapshot` (liste chargée à la demande par `lfsFiles`).

import type { LfsFiles, LfsInfo, LfsPattern } from '../shared/types';
import {
  lfsPullArgs,
  lfsIncludeError,
  lfsPointerChange,
  lfsPathsFromCheckAttr,
  lfsPatternError,
  parseGitattributesLfs,
  parseLfsFiles,
  parseLfsFilesJson,
  parseLfsVersion,
} from '../shared/lfs';

/** Filtre LFS neutralisé : les fichiers sont comparés tels quels à l'index (lecture seule, git-lfs absent). */
const LFS_FILTER_OFF = ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false'];

/**
 * Arguments et environnement de `git lfs <args>`. Jamais `--literal-pathspecs` ici, et `GIT_LITERAL_PATHSPECS`
 * forcé à 0 (au cas où il viendrait de l'environnement) : la variable se propage aux `git` lancés par git-lfs, qui
 * utilise des pathspecs magiques (git-lfs 3.8 : `git ls-files ':(top,attr:filter=lfs)'`) ; rendues littérales,
 * elles ne trouvent aucun fichier et `git lfs pull` réussit sans rien récupérer. Les chemins passés à git-lfs
 * (`--include`, motif après `--`) sont validés en amont et ne sont pas des pathspecs Git.
 */
export function lfsCommand(args: string[]): { args: string[]; env: Record<string, string> } {
  return { args: ['lfs', ...args], env: { GIT_LITERAL_PATHSPECS: '0' } };
}

function lfs(repo: string, args: string[]): Promise<string> {
  const c = lfsCommand(args);
  return git(repo, c.args, { env: c.env });
}

/** Erreur due à un git-lfs introuvable. */
export function isLfsMissing(e: unknown): boolean {
  return e instanceof GitError && LFS_MISSING.test(e.stderr);
}

/**
 * Statut d'un dépôt LFS sans git-lfs : `git status` échoue dès qu'un fichier LFS doit passer par le filtre (fichier
 * modifié). Relu sans le filtre pour que le dépôt s'affiche (un fichier LFS modifié apparaît modifié) ; toute autre
 * erreur est relancée.
 */
export async function statusWithoutLfs(repo: string, e: unknown): Promise<WorkingStatus> {
  if (!isLfsMissing(e)) throw e;
  return status(repo, LFS_FILTER_OFF);
}

/** Résultat de `git lfs version` gardé pour le processus ; une absence est revérifiée après ce délai. */
const LFS_RECHECK_MS = 30_000;
let lfsVersionCache: { installed: boolean; version: string | null; at: number } | null = null;

/** Oublie le résultat de `git lfs version` (tests : changement de PATH). */
export function forgetLfsVersion() {
  lfsVersionCache = null;
}

export async function lfsVersion(repo: string): Promise<{ installed: boolean; version: string | null }> {
  const c = lfsVersionCache;
  if (c && (c.installed || Date.now() - c.at < LFS_RECHECK_MS)) return c;
  const out = await lfs(repo, ['version']).catch(() => null);
  lfsVersionCache = { installed: out !== null, version: out === null ? null : parseLfsVersion(out), at: Date.now() };
  return lfsVersionCache;
}

async function requireLfs(repo: string) {
  if (!(await lfsVersion(repo)).installed)
    throw new GitError("git-lfs n'est pas installé (ou introuvable dans le PATH) : installez-le puis relancez Arbor.", '');
}

/**
 * Motifs du `.gitattributes` racine, lus en Node : `git lfs track`, même pour lister, installe des hooks et écrit
 * `.git/config`. Les `.gitattributes` des sous-dossiers ne sont pas listés.
 */
async function lfsPatterns(repo: string): Promise<LfsPattern[]> {
  const text = await readTextOrNull(join(repo, '.gitattributes'));
  return text === null ? [] : parseGitattributesLfs(text);
}

/** Nombre maximal de chemins du statut examinés par `check-attr`. */
const LFS_ATTR_MAX = 10_000;

export async function lfsInfo(repo: string, paths: unknown): Promise<LfsInfo> {
  const list = (Array.isArray(paths) ? paths : [])
    .filter((p): p is string => typeof p === 'string' && p !== '' && !p.includes('\0'))
    .slice(0, LFS_ATTR_MAX);
  const [{ installed, version }, features] = await Promise.all([lfsVersion(repo), repoFeatures(repo)]);
  // Lecture pure : seuls `git lfs version` (n'écrit rien) et `git check-attr` sont lancés, jamais `git lfs track`.
  if (!features.lfs) return { installed, version, patterns: [], lfsPaths: [] };
  const [patterns, lfsPaths] = await Promise.all([
    lfsPatterns(repo),
    list.length
      ? git(repo, ['check-attr', '-z', '--stdin', 'filter'], { input: list.map((p) => `${p}\0`).join('') }).then(lfsPathsFromCheckAttr)
      : Promise.resolve([]),
  ]);
  return { installed, version, patterns, lfsPaths };
}

const LFS_FILES_MAX = 1000;

async function allLfsFiles(repo: string) {
  await requireLfs(repo);
  const json = await lfs(repo, ['ls-files', '--json']).catch(() => null);
  return (json === null ? null : parseLfsFilesJson(json)) ?? parseLfsFiles(await lfs(repo, ['ls-files', '-l']));
}

export async function lfsFiles(repo: string): Promise<LfsFiles> {
  const files = await allLfsFiles(repo);
  return { files: files.slice(0, LFS_FILES_MAX), truncated: files.length > LFS_FILES_MAX };
}

/** Suit ou ne suit plus un motif (validé, toujours après `--`) ; `untrack` n'accepte qu'un motif suivi du `.gitattributes` racine. */
export async function lfsTrack(repo: string, pattern: unknown, untrack: unknown) {
  const err = lfsPatternError(pattern);
  if (err) throw new GitError(err, '');
  const p = pattern as string;
  await requireLfs(repo);
  if (untrack === true) {
    const known = (await lfsPatterns(repo)).some((x) => x.pattern === p && x.source === '.gitattributes' && !x.excluded);
    if (!known) throw new GitError(`« ${p} » n'est pas un motif suivi du .gitattributes racine.`, '');
  }
  await lfs(repo, [untrack === true ? 'untrack' : 'track', '--', p]);
}

export async function lfsFetch(repo: string) {
  await requireLfs(repo);
  await lfs(repo, ['fetch']);
}

/** Nombre maximal de fichiers récupérés un par un (au-delà, tout récupérer). */
const LFS_PULL_MAX = 100;

export async function lfsPull(repo: string, paths: unknown) {
  await requireLfs(repo);
  if (paths === null) {
    await lfs(repo, ['pull']);
    return;
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > LFS_PULL_MAX || !paths.every((p) => typeof p === 'string'))
    throw new GitError('Liste de fichiers LFS invalide.', '');
  for (const p of paths as string[]) {
    const err = lfsIncludeError(p);
    if (err) throw new GitError(err, '');
  }
  // Chemins revérifiés contre la liste recalculée : `--include` ne reçoit que des fichiers LFS connus.
  const known = new Set((await allLfsFiles(repo)).map((f) => f.path));
  const unknown = (paths as string[]).find((p) => !known.has(p));
  if (unknown !== undefined) throw new GitError(`« ${unknown} » n'est pas un fichier LFS de ce dépôt.`, '');
  for (const args of lfsPullArgs(paths as string[])) await lfs(repo, ['pull', ...args]);
}
