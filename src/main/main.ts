import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as g from './git';
import { RepoWatcher } from './watcher';
import { mergePreferences, normalizePreferences, type Preferences } from '../shared/prefs';

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

// Session des onglets : `userData/session.json` = { repos: chemins des onglets, active: index de l'onglet actif }.
const sessionFile = () => join(app.getPath('userData'), 'session.json');

/** Rouvre un dépôt de la session sans le remettre en tête des récents ; `null` s'il n'existe plus. */
async function reopenRepo(path: string): Promise<string | null> {
  try {
    if (!existsSync(path) || !(await g.isRepo(path))) return null;
    const top = await g.toplevel(path);
    openedRepos.add(top);
    return top;
  } catch {
    return null;
  }
}

async function restoreSession(): Promise<{ repos: string[]; active: number }> {
  let data: { repos?: unknown; active?: unknown };
  try {
    data = JSON.parse(readFileSync(sessionFile(), 'utf8'));
  } catch {
    return { repos: [], active: 0 };
  }
  const saved = Array.isArray(data?.repos) ? data.repos.filter((p): p is string => typeof p === 'string') : [];
  const activeIndex = typeof data?.active === 'number' ? data.active : 0;
  // Vérifications en parallèle, ordre conservé.
  const tops = await Promise.all(saved.map(reopenRepo));
  const repos: string[] = [];
  let active = 0;
  tops.forEach((top, i) => {
    if (!top) return; // dépôt supprimé ou déplacé entre deux sessions : onglet écarté
    if (!repos.includes(top)) repos.push(top);
    if (i === activeIndex) active = repos.indexOf(top);
  });
  return { repos, active };
}

/** N'enregistre que des dépôts ouverts dans Arbor (mêmes règles que `assertOpened`). */
function saveSession(repos: unknown, active: unknown) {
  const recent = loadRecent();
  const list = Array.isArray(repos) ? repos.filter((p): p is string => typeof p === 'string' && (openedRepos.has(p) || recent.includes(p))) : [];
  const i = typeof active === 'number' && Array.isArray(repos) ? list.indexOf(repos[active]) : -1;
  writeFileAtomic(sessionFile(), JSON.stringify({ repos: list, active: Math.max(0, i) }));
}

/**
 * Menu minimal : rôles d'édition (copier, coller…) pour les champs de saisie, sans « Fermer » ni « Recharger »,
 * afin que Ctrl/Cmd+W ferme l'onglet (géré par le rendu) et non la fenêtre.
 */
function installMenu() {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });
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
