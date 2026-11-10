import type { FinalNewlines, MergeBlock } from './merge3';
import type { Preferences } from './prefs';
import type { RebaseProgress, RebaseStep } from './rebase';

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
  /** Progression d'un rebase en cours (état `rebasing`), sinon null ou absent. */
  rebase?: RebaseProgress | null;
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
  /**
   * Fonctionnalités détectées sans lancer `git` (fichiers seulement) : `submodules` = `.gitmodules` présent ;
   * `lfs` = `.gitattributes` racine avec `filter=lfs` ou dossier `<gitDir>/lfs`. Absent = non calculé.
   */
  features?: RepoFeatures;
}

export interface RepoFeatures {
  submodules: boolean;
  lfs: boolean;
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
  /** `keep` : garde les modifications locales, refusé si elles touchent un fichier qui change (`git reset --keep`). */
  reset(repo: string, sha: string, mode: 'soft' | 'mixed' | 'hard' | 'keep'): Promise<void>;
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
  /** Commits réécrits par un rebase interactif sur `base` ; `ancestorOnly` : `base` doit être un ancêtre de HEAD. */
  rebasePlan(repo: string, base: string, ancestorOnly: boolean): Promise<RebasePlan>;
  /**
   * Lance `git rebase -i` sur `upstream` ; `steps` dans l'ordre de Git (plus ancien d'abord). HEAD doit valoir
   * `expectedHead` et les commits ceux du plan. « stopped » : arrêt sur un « edit » (un conflit lève une erreur).
   */
  rebaseInteractive(repo: string, upstream: string, expectedHead: string, steps: RebaseStep[]): Promise<'done' | 'stopped'>;
  /** Passe l'étape en cours d'un rebase, d'un cherry-pick ou d'un revert. */
  skipOp(repo: string): Promise<void>;
  /** Trois versions d'un fichier en conflit (éditeur de fusion), « ma version » selon l'opération (inversée en rebase). */
  conflictVersions(repo: string, path: string): Promise<ConflictVersions>;
  /** Écrit le résultat si le fichier a encore l'empreinte `expectedHash`, l'indexe si `markResolved` ; renvoie la nouvelle empreinte. */
  saveResolution(repo: string, path: string, content: string, expectedHash: string | null, markResolved: boolean): Promise<string>;
  /** Conflit suppression/modification : garde le fichier de l'arbre de travail (`git add`) ou le supprime (`git rm`). */
  resolveDeletion(repo: string, path: string, keep: boolean): Promise<void>;
  /** Identité actuelle des étages d'un fichier en conflit (comparée à `ConflictVersions.stages`) ; null s'il n'est plus en conflit. */
  conflictStages(repo: string, path: string): Promise<string | null>;
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
  // reflog
  /** Page du reflog de `ref` (« HEAD » ou nom de branche locale), plus récent d'abord, à partir de l'entrée `skip`. */
  reflog(repo: string, ref: string, skip: number): Promise<ReflogEntry[]>;
  /** Dernière opération annulable de la branche extraite (bouton Annuler), ou la raison du refus. */
  undoInfo(repo: string): Promise<UndoInfo>;
  /** Annule la dernière opération si HEAD vaut encore `expectedHead` et la cible `expectedTarget` (voir `undoInfo`). */
  undoLast(repo: string, expectedHead: string, expectedTarget: string): Promise<void>;

  // glisser-déposer

  // sous-modules
  /**
   * Sous-modules déclarés dans `.gitmodules` et leur état (aucun `git` lancé dans les sous-modules). `changed` : chemins
   * présents dans le statut du dépôt ; le statut détaillé n'est lu que pour eux (les autres sont à jour).
   */
  submodules(repo: string, changed: string[]): Promise<Submodule[]>;
  /** Commit extrait dans un sous-module initialisé ; null s'il n'est pas initialisé ou sans commit. */
  submoduleHead(repo: string, path: string): Promise<string | null>;
  /**
   * Initialise un sous-module non initialisé, ou tous ceux qui ne le sont pas (`path` null) : `--init --checkout`.
   * Refuse un sous-module déjà initialisé (jamais de déplacement sans confirmation).
   */
  submoduleInit(repo: string, path: string | null): Promise<void>;
  /** Revient au commit attendu `expected` (`git submodule update --checkout -- <chemin>`), refusé s'il a changé. */
  submoduleReset(repo: string, path: string, expected: string): Promise<void>;
  /** Recopie les URL de `.gitmodules` dans la configuration (`git submodule sync --recursive`). */
  submoduleSync(repo: string): Promise<void>;
  /** Valide un sous-module initialisé et l'autorise comme dépôt ; renvoie son chemin, à ouvrir dans un onglet. */
  openSubmodule(repo: string, path: string): Promise<string>;

  // lfs
  /**
   * git-lfs installé (version), motifs suivis ou exclus (`git lfs track --json` ; sans git-lfs, `.gitattributes`
   * racine) et, parmi `paths` (fichiers du statut), ceux dont l'attribut `filter` vaut `lfs`. Ne lit jamais la liste
   * des fichiers LFS (voir `lfsFiles`).
   */
  lfsInfo(repo: string, paths: string[]): Promise<LfsInfo>;
  /** Fichiers LFS de HEAD et de l'index (`git lfs ls-files --json`), au plus 1 000. Coûteux : chargement à la demande. */
  lfsFiles(repo: string): Promise<LfsFiles>;
  /** Suit (`git lfs track -- <motif>`) ou ne suit plus (`untrack`) un motif du `.gitattributes` racine. */
  lfsTrack(repo: string, pattern: string, untrack: boolean): Promise<void>;
  /** Télécharge les objets LFS de la branche courante sans toucher à l'arbre de travail (`git lfs fetch`). */
  lfsFetch(repo: string): Promise<void>;
  /** Télécharge et extrait les fichiers LFS : tous (`paths` null) ou ceux donnés (`--include`), revérifiés. */
  lfsPull(repo: string, paths: string[] | null): Promise<void>;

  // état des onglets
}

/** Commits qu'un rebase interactif peut réécrire (`upstream..HEAD`, sans fusion), plus ancien d'abord. */
export interface RebasePlan {
  /** SHA de la base. */
  upstream: string;
  /** Commit sur lequel les commits sont rejoués (= `upstream`). */
  onto: string;
  /** HEAD au moment du plan, revérifié au lancement. */
  head: string;
  /** Branche réécrite, null en HEAD détachée. */
  branch: string | null;
  /** `published` : déjà présent sur la branche distante suivie. */
  commits: (Commit & { published: boolean })[];
  /** Fichiers indexés ou modifiés (hors non suivis) : le rebase est refusé. */
  dirty: boolean;
}

/** Versions d'un fichier en conflit pour l'éditeur de fusion ; null = absent de ce côté (supprimé, ou pas de base). */
export interface ConflictVersions {
  base: string | null;
  mine: string | null;
  theirs: string | null;
  /** SHA-1 du fichier de l'arbre de travail au chargement (null s'il est absent), vérifié à l'enregistrement. */
  workingHash: string | null;
  /** Binaire ou non UTF-8 : contenus vidés, repli sur la vue simple. */
  binary: boolean;
  /** Plus de 1 Mo, 20 000 lignes ou 2 000 blocs : contenus vidés, repli sur la vue simple. */
  tooLarge: boolean;
  /** Sous-module, lien symbolique ou filtre de contenu (`filter`, LFS…) : repli sur la vue simple. */
  unsupported?: 'submodule' | 'symlink' | 'filter' | 'mixed-eol';
  /** Fusion calculée par `git merge-file --diff3` (ma version d'abord) ; null hors fusion de texte ou sortie illisible. */
  merge: MergeModel | null;
  /** Le fichier de l'arbre de travail est encore celui écrit par Git (aucune résolution commencée ailleurs). */
  workingMatches: boolean;
  /** Identité des étages (voir `conflictStages`) : change quand l'opération passe à une autre étape. */
  stages: string;
}

/** Blocs de l'éditeur de fusion, tirés de la sortie de Git (voir `shared/merge3.ts`). */
export interface MergeModel {
  blocks: MergeBlock[];
  eol: '\n' | '\r\n';
  finalNewline: FinalNewlines;
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

/** Nature d'une entrée du reflog, tirée de son message (`%gs`). */
export type ReflogKind = 'commit' | 'amend' | 'merge' | 'rebase' | 'reset' | 'pull' | 'cherry-pick' | 'revert' | 'checkout' | 'other';

/** Entrée du reflog d'une référence (log -g). */
export interface ReflogEntry {
  /** Position dans le reflog (0 = état actuel), pour le sélecteur `ref@{index}`. */
  index: number;
  /** Sélecteur lisible, ex. `main@{2}`. */
  selector: string;
  /** Commit pointé par la référence après l'opération. */
  sha: string;
  /** Message du reflog, ex. « commit (amend): Corrige… », « rebase (finish): refs/heads/x onto … ». */
  subject: string;
  kind: ReflogKind;
  /** Date de l'opération (secondes Unix), pas celle du commit. */
  date: number;
}

/** Annulation de la dernière opération d'une branche : reset `--soft` (commit, amend) ou `--keep` (le reste). */
export interface UndoPlan {
  kind: ReflogKind;
  /** Message du reflog de l'opération annulée, raccourci pour l'affichage. */
  label: string;
  /** Commit vers lequel la branche revient (entrée précédente du reflog). */
  target: string;
  mode: 'soft' | 'keep';
}

/** Réponse de `undoInfo` : `plan` null avec `reason` quand rien n'est annulable. */
export interface UndoInfo {
  branch: string | null;
  head: string | null;
  plan: UndoPlan | null;
  reason: string | null;
}

// glisser-déposer

// sous-modules

/**
 * État d'un sous-module : `uninitialized` = dossier sans `.git` ; `ok` = commit attendu extrait ; `changed` = autre
 * commit extrait ; `conflict` = gitlink en conflit dans l'index ; `missing` = déclaré dans `.gitmodules` mais absent
 * de l'index.
 */
export type SubmoduleState = 'uninitialized' | 'ok' | 'changed' | 'conflict' | 'missing';

export interface Submodule {
  /** Nom dans `.gitmodules` (`submodule.<nom>.path`), souvent égal au chemin. */
  name: string;
  path: string;
  url: string | null;
  branch: string | null;
  /** Commit attendu (gitlink de l'index, étage 0) ; null s'il est absent ou en conflit. */
  expected: string | null;
  initialized: boolean;
  state: SubmoduleState;
  /** Fichiers suivis modifiés dans le sous-module (initialisé seulement). */
  dirty: boolean;
  /** Fichiers non suivis dans le sous-module (initialisé seulement). */
  untracked: boolean;
}

// lfs

/** Motif LFS : `excluded` = exclusion (`-filter`, `!filter`) ; `source` = fichier `.gitattributes` qui le déclare. */
export interface LfsPattern {
  pattern: string;
  source: string;
  excluded: boolean;
}

export interface LfsInfo {
  /** git-lfs utilisable par Arbor (`git lfs version` réussit). */
  installed: boolean;
  version: string | null;
  patterns: LfsPattern[];
  /** Chemins demandés dont l'attribut `filter` vaut `lfs` (stockés dans LFS au prochain commit). */
  lfsPaths: string[];
}

export interface LfsFile {
  path: string;
  /** Empreinte SHA-256 de l'objet. */
  oid: string;
  /** Le fichier de l'arbre de travail est le contenu ; false = pointeur seul (objet non récupéré ou non extrait). */
  present: boolean;
  /** Taille de l'objet en octets (null si git-lfs ne la donne pas). */
  size: number | null;
}

export interface LfsFiles {
  files: LfsFile[];
  /** Liste tronquée à 1 000 fichiers. */
  truncated: boolean;
}

// état des onglets
