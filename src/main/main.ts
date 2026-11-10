import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import * as g from './git';
import { RepoWatcher } from './watcher';
import { mergePreferences, normalizePreferences, type Preferences } from '../shared/prefs';
import { MISSING_LIMIT, normalizeSession, type SessionData } from '../shared/session';

// Données utilisateur isolées (tests d'interface) : à fixer avant `ready`.
if (process.env.ARBOR_USER_DATA) app.setPath('userData', resolve(process.env.ARBOR_USER_DATA));

let win: BrowserWindow | null = null;

const recentFile = () => join(app.getPath('userData'), 'recent.json');

function loadRecent(): string[] {
  try {
    return JSON.parse(readFileSync(recentFile(), 'utf8')).filter((p: string) => existsSync(p));
  } catch {
    return [];
  }
}

function remember(path: string) {
  const list = [path, ...loadRecent().filter((p) => p !== path)].slice(0, 12);
  writeFileSync(recentFile(), JSON.stringify(list));
}

// Préférences : `userData/prefs.json`, toujours normalisées à la lecture comme à l'écriture.
const prefsFile = () => join(app.getPath('userData'), 'prefs.json');
let prefsCache: Preferences | null = null;

function loadPreferences(): Preferences {
  if (!prefsCache) {
    try {
      prefsCache = normalizePreferences(JSON.parse(readFileSync(prefsFile(), 'utf8')));
    } catch (e) {
      prefsCache = normalizePreferences(undefined);
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Fichier illisible ou corrompu : on le met de côté au lieu de l'écraser à la prochaine écriture.
        console.warn('Préférences illisibles, valeurs par défaut utilisées :', e);
        try {
          renameSync(prefsFile(), `${prefsFile()}.corrupt`);
        } catch {
          // rien à mettre de côté
        }
      }
    }
  }
  return prefsCache;
}

/** Écriture atomique : un arrêt brutal ne laisse jamais un fichier tronqué. */
function writeFileAtomic(file: string, content: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function savePreferences(patch: unknown): Preferences {
  const next = mergePreferences(loadPreferences(), patch);
  writeFileAtomic(prefsFile(), JSON.stringify(next, null, 2));
  prefsCache = next;
  nativeTheme.themeSource = next.theme;
  return next;
}

// Couleur de fond de la fenêtre avant le premier rendu (doit suivre `--bg` du thème).
const BACKGROUND = { dark: '#14161c', light: '#f6f7f9' };

// Dépôts que l'utilisateur a ouverts (dialogue, argument ou liste des récents) : le rendu ne peut agir que sur eux.
const openedRepos = new Set<string>();

async function openRepo(path: string): Promise<string> {
  if (!(await g.isRepo(path))) throw new Error(`« ${basename(path)} » n'est pas un dépôt Git.`);
  const top = await g.toplevel(path);
  openedRepos.add(top);
  remember(top);
  return top;
}

function assertOpened(repo: unknown) {
  if (typeof repo !== 'string' || !(openedRepos.has(repo) || loadRecent().includes(repo))) {
    throw new Error("Ce dépôt n'a pas été ouvert dans Arbor.");
  }
}

// Session des onglets : `userData/session.json` = { repos, active, missing } (voir `shared/session.ts`).
const sessionFile = () => join(app.getPath('userData'), 'session.json');

/** Délai maximal de vérification d'un dépôt à la restauration (montage réseau figé). */
const REOPEN_TIMEOUT_MS = 3000;

/**
 * Dépôts de la session indisponibles à la restauration, réinjectés à chaque sauvegarde (tant qu'ils ne sont pas
 * rouverts) ; `null` tant que la session n'a été ni restaurée ni relue.
 */
let missingRepos: string[] | null = null;

function readSession(): SessionData {
  try {
    return normalizeSession(JSON.parse(readFileSync(sessionFile(), 'utf8')));
  } catch {
    return normalizeSession(undefined);
  }
}

type Reopened = { kind: 'ok'; top: string } | { kind: 'missing' | 'gone' };

/**
 * Vérifie un dépôt de la session sans le remettre en tête des récents : `ok` avec son chemin ; `missing` s'il est
 * inaccessible (dossier absent, délai dépassé) ; `gone` s'il n'est plus un dépôt à cet endroit (`.git` supprimé :
 * `git` remonterait alors jusqu'à un dépôt parent, par exemple le dossier personnel).
 */
async function reopenRepo(path: string): Promise<Reopened> {
  let timedOut = false;
  const check = async (): Promise<Reopened> => {
    try {
      await access(path);
    } catch {
      return { kind: 'missing' };
    }
    try {
      if (!(await g.isRepo(path))) return { kind: 'gone' };
      const top = await g.toplevel(path);
      if ((await realpath(top)) !== (await realpath(path))) return { kind: 'gone' };
      // Réponse arrivée après le délai : le dépôt reste indisponible pour cette session.
      if (timedOut) return { kind: 'missing' };
      openedRepos.add(top);
      return { kind: 'ok', top };
    } catch {
      return { kind: 'gone' };
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Reopened>((done) => {
    timer = setTimeout(() => {
      timedOut = true;
      done({ kind: 'missing' });
    }, REOPEN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function restoreSession(): Promise<{ repos: string[]; active: number }> {
  const saved = readSession();
  // Dépôts indisponibles la dernière fois en fin de liste : leur onglet revient s'ils sont de nouveau accessibles.
  const candidates = [...saved.repos, ...saved.missing];
  const results = await Promise.all(candidates.map(reopenRepo)); // en parallèle, ordre conservé
  const repos: string[] = [];
  const missing: string[] = [];
  let active = 0;
  results.forEach((r, i) => {
    if (r.kind === 'missing') missing.push(candidates[i]);
    if (r.kind !== 'ok') return; // `gone` : onglet écarté
    if (!repos.includes(r.top)) repos.push(r.top);
    if (i === saved.active && i < saved.repos.length) active = repos.indexOf(r.top);
  });
  missingRepos = missing.slice(0, MISSING_LIMIT);
  return { repos, active };
}

/** N'enregistre que des dépôts ouverts dans Arbor (mêmes règles que `assertOpened`), plus les dépôts indisponibles. */
function saveSession(repos: unknown, active: unknown) {
  const recent = loadRecent();
  const s = normalizeSession({ repos, active }, (p) => openedRepos.has(p) || recent.includes(p));
  if (missingRepos === null) missingRepos = readSession().missing; // restauration désactivée : on les garde
  missingRepos = missingRepos.filter((p) => !s.repos.includes(p));
  const data: SessionData = { ...s, missing: missingRepos };
  writeFileAtomic(sessionFile(), JSON.stringify(data));
}

/**
 * Menu minimal : rôles d'édition (copier, coller…) pour les champs de saisie, sans « Fermer » ni « Recharger »,
 * afin que Ctrl/Cmd+W ferme l'onglet (géré par le rendu) et non la fenêtre.
 */
function installMenu() {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });
  // Hors macOS, « Quitter » (Ctrl+Q) : le menu de l'application n'existe pas.
  else template.push({ label: 'Fichier', submenu: [{ role: 'quit', label: 'Quitter', accelerator: 'Ctrl+Q' }] });
  template.push({
    label: 'Édition',
    submenu: [
      { role: 'undo', label: 'Annuler' },
      { role: 'redo', label: 'Rétablir' },
      { type: 'separator' },
      { role: 'cut', label: 'Couper' },
      { role: 'copy', label: 'Copier' },
      { role: 'paste', label: 'Coller' },
      { role: 'selectAll', label: 'Tout sélectionner' },
    ],
  });
  template.push({
    label: 'Affichage',
    submenu: [
      { role: 'resetZoom', label: 'Taille réelle' },
      { role: 'zoomIn', label: 'Zoom avant' },
      { role: 'zoomOut', label: 'Zoom arrière' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Plein écran' },
    ],
  });
  // macOS : menu Fenêtre construit à la main (le rôle `windowMenu` ajouterait « Fermer », Cmd+W).
  if (process.platform === 'darwin') {
    template.push({
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Réduire' },
        { role: 'zoom', label: 'Agrandir' },
      ],
    });
  }
  if (!app.isPackaged) template.push({ label: 'Développement', submenu: [{ role: 'toggleDevTools', label: 'Outils de développement' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Handlers qui ne reçoivent pas de dépôt en premier argument.
const NO_REPO = new Set(['openRepoDialog', 'initRepoDialog', 'cloneRepo', 'recentRepos', 'initialRepo', 'unwatchRepo', 'getPreferences', 'setPreferences', 'restoreSession', 'saveSession']);

// Handlers en lecture seule, hors sourdine du rafraîchissement automatique. Liste blanche : toute nouvelle
// commande est mise en sourdine par défaut. Les noms absents de `handlers` (autres branches) sont sans effet.
// `diff` n'y figure pas : `git diff` peut réécrire `.git/index` (entrées à date modifiée mais contenu inchangé).
const READ_ONLY = new Set([
  'snapshot',
  'readFile',
  'commitFiles',
  'recentRepos',
  'initialRepo',
  'openRepoDialog',
  'watchRepo',
  'unwatchRepo',
  'searchCommitsByPath',
  'fileLog',
  'blame',
  'getPreferences',
  'setPreferences',
  'restoreSession',
  'saveSession',
  // rebase interactif
  'rebasePlan',
  'conflictStages', // ls-files --no-optional-locks : n'écrit rien
  // remotes
  'remoteConfig',
  // tags
  'remoteTags',
  // reflog
  'reflog',
  'undoInfo',

  // glisser-déposer

  // sous-modules
  'submodules', // ls-files et status --no-optional-locks : n'écrivent rien
  'submoduleHead',
  'openSubmodule', // valide le chemin, n'écrit que la liste des récents

  // lfs

  // état des onglets
]);

const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {
  async openRepoDialog() {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Ouvrir un dépôt' });
    return r.canceled ? null : openRepo(r.filePaths[0]);
  },
  async initRepoDialog() {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Initialiser un dépôt' });
    if (r.canceled) return null;
    await g.git(r.filePaths[0], ['init']);
    return openRepo(r.filePaths[0]);
  },
  async cloneRepo(url: string) {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Dossier de destination' });
    if (r.canceled) return null;
    const name = basename(url).replace(/\.git$/, '') || 'repo';
    await g.git(r.filePaths[0], ['clone', '--', url, name]);
    return openRepo(join(r.filePaths[0], name));
  },
  recentRepos: async () => loadRecent(),
  // Permet d'ouvrir directement un dépôt : `electron . /chemin/du/depot`
  async initialRepo() {
    const appPath = resolve(app.getAppPath());
    const arg = process.argv
      .slice(1)
      .filter((a) => !a.startsWith('-') && existsSync(a) && resolve(a) !== appPath)
      .pop();
    return arg ? openRepo(arg) : null;
  },
  snapshot: g.snapshot,
  searchCommitsByPath: g.searchCommitsByPath,
  commitFiles: g.commitFiles,
  diff: g.diff,
  readFile: g.readFile,
  fileLog: g.fileLog,
  blame: g.blame,
  stage: g.stage,
  unstage: g.unstage,
  discard: g.discard,
  applyPatchSelection: g.applyPatchSelection,
  commit: g.commit,
  checkout: g.checkout,
  createBranch: g.createBranch,
  deleteBranch: g.deleteBranch,
  merge: g.merge,
  rebase: g.rebase,
  abort: g.abort,
  continueOp: g.continueOp,
  resolve: g.resolve,
  fetch: g.fetch,
  pull: g.pull,
  push: g.push,
  stashSave: g.stashSave,
  stashApply: g.stashApply,
  stashDrop: g.stashDrop,
  createTag: g.createTag,
  cherryPick: g.cherryPick,
  revert: g.revert,
  reset: g.reset,
  watchRepo: (repo: string) => watcher.watch(repo),
  unwatchRepo: async () => watcher.stop(),
  getPreferences: async () => loadPreferences(),
  setPreferences: async (patch: unknown) => savePreferences(patch),
  restoreSession: async () => restoreSession(),
  saveSession: async (repos: unknown, active: unknown) => saveSession(repos, active),
  // rebase interactif
  rebasePlan: (repo: string, base: unknown, ancestorOnly: unknown) => g.rebasePlan(repo, String(base), ancestorOnly === true),
  rebaseInteractive: (repo: string, upstream: unknown, expectedHead: unknown, steps: unknown) =>
    g.rebaseInteractive(repo, String(upstream), String(expectedHead), Array.isArray(steps) ? steps : []),
  skipOp: g.skipOp,
  conflictVersions: g.conflictVersions,
  saveResolution: g.saveResolution,
  resolveDeletion: g.resolveDeletion,
  conflictStages: g.conflictStages,
  // remotes
  remoteConfig: g.remoteConfig,
  addRemote: g.addRemote,
  renameRemote: g.renameRemote,
  removeRemote: g.removeRemote,
  setRemoteUrl: g.setRemoteUrl,
  fetchRemote: g.fetchRemote,
  pruneRemote: g.pruneRemote,
  // tags
  checkoutTag: g.checkoutTag,
  deleteTag: g.deleteTag,
  deleteRemoteTag: g.deleteRemoteTag,
  pushTag: g.pushTag,
  pushAllTags: g.pushAllTags,
  remoteTags: g.remoteTags,
  // reflog
  reflog: (repo: string, ref: unknown, skip: unknown) => g.reflog(repo, String(ref), Number(skip)),
  undoInfo: g.undoInfo,
  undoLast: (repo: string, expectedHead: unknown, expectedTarget: unknown) => g.undoLast(repo, String(expectedHead), String(expectedTarget)),

  // glisser-déposer

  // sous-modules
  submodules: (repo: string, changed: unknown) => g.submodules(repo, changed),
  submoduleHead: g.submoduleHead,
  submoduleInit: (repo: string, path: unknown) => g.submoduleInit(repo, path),
  submoduleReset: (repo: string, path: unknown, expected: unknown) => g.submoduleReset(repo, path, expected),
  submoduleSync: g.submoduleSync,
  // Chemin revérifié (déclaré, initialisé, racine de son propre dépôt) avant d'être autorisé comme dépôt ouvert.
  openSubmodule: async (repo: string, path: unknown) => openRepo(await g.submoduleRoot(repo, path)),

  // lfs

  // état des onglets
};

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(`arbor:${name}`, async (_e, ...args) => {
    try {
      if (!NO_REPO.has(name)) assertOpened(args[0]);
      // En sourdine : ce que la commande écrit dans le dépôt ne déclenche pas de rafraîchissement automatique.
      // Les lectures n'écrivent rien : elles ne coupent pas le son, pour ne pas masquer un changement externe.
      if (READ_ONLY.has(name)) return { value: await fn(...args) };
      return { value: await watcher.mute(() => fn(...args)) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function createWindow() {
  installMenu();
  nativeTheme.themeSource = loadPreferences().theme;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    title: 'Arbor',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  const devUrl = process.env.ARBOR_DEV_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

// Surveillance du dépôt ouvert : les changements faits hors d'Arbor sont signalés au rendu.
const sendEvent = (name: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(`arbor:event:${name}`, payload);
};
const watcher = new RepoWatcher(
  (ev) => sendEvent('repoChanged', ev),
  (ev) => sendEvent('watchLimited', ev),
);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => watcher.stop());
