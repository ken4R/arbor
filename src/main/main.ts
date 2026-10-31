import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as g from './git';

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

// Handlers qui ne reçoivent pas de dépôt en premier argument.
const NO_REPO = new Set(['openRepoDialog', 'initRepoDialog', 'cloneRepo', 'recentRepos', 'initialRepo']);

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
  commitFiles: g.commitFiles,
  diff: g.diff,
  readFile: g.readFile,
  stage: g.stage,
  unstage: g.unstage,
  discard: g.discard,
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
};

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(`arbor:${name}`, async (_e, ...args) => {
    try {
      if (!NO_REPO.has(name)) assertOpened(args[0]);
      return { value: await fn(...args) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#14161c',
    title: 'Arbor',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  const devUrl = process.env.ARBOR_DEV_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
