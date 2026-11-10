// Lance Arbor dans Electron (sans écran via xvfb-run), ouvre un dépôt et prend des captures.
// Usage : xvfb-run -a node scripts/ui-check.cjs <dépôt> <dossier-captures> [scénario.cjs] [--keep-user-data[=<dossier>]] [--path-without-lfs]
// Un scénario exporte `async (win, shot) => {}` ; `shot(nom)` enregistre une capture.
// Données utilisateur (préférences, dépôts récents) : dossier temporaire neuf à chaque lancement, sauf avec
// `--keep-user-data`, qui réutilise un dossier fixe (ou celui donné) pour tester un redémarrage.
// `--path-without-lfs` : PATH réduit à un dossier temporaire qui ne contient que `git` (simule un poste sans git-lfs).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { _electron } = require('playwright');

const argv = process.argv.slice(2);
const keepArg = argv.find((a) => a === '--keep-user-data' || a.startsWith('--keep-user-data='));
const [repo, outDir, scenario] = argv.filter((a) => !a.startsWith('--'));
if (!repo || !outDir) {
  console.error('Usage : node scripts/ui-check.cjs <dépôt> <dossier-captures> [scénario.cjs] [--keep-user-data[=<dossier>]] [--path-without-lfs]');
  process.exit(1);
}
// Dossier fixe propre à cette copie du dépôt : deux worktrees lancés en parallèle ne partagent pas leurs données.
const rootTag = require('node:crypto').createHash('sha1').update(path.resolve(__dirname, '..')).digest('hex').slice(0, 8);
const userData = keepArg
  ? path.resolve(keepArg.includes('=') ? keepArg.slice(keepArg.indexOf('=') + 1) : path.join(os.tmpdir(), `arbor-ui-check-user-data-${rootTag}`))
  : fs.mkdtempSync(path.join(os.tmpdir(), 'arbor-ui-check-'));
fs.mkdirSync(userData, { recursive: true });
console.log('données utilisateur :', userData);
// Sans git-lfs : seul `git` est trouvable dans le PATH d'Electron (git-lfs est un exécutable séparé du PATH).
let pathWithoutLfs = null;
if (argv.includes('--path-without-lfs')) {
  const gitBin = require('node:child_process').execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  pathWithoutLfs = fs.mkdtempSync(path.join(os.tmpdir(), 'arbor-sans-lfs-'));
  fs.symlinkSync(fs.realpathSync(gitBin), path.join(pathWithoutLfs, 'git'));
  console.log('PATH sans git-lfs :', pathWithoutLfs);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  fs.mkdirSync(outDir, { recursive: true });
  const app = await _electron.launch({
    executablePath: require(path.join(root, 'node_modules/electron')),
    args: [root, '--no-sandbox', path.resolve(repo)],
    cwd: root,
    env: { ...process.env, ARBOR_USER_DATA: userData, ...(pathWithoutLfs ? { PATH: pathWithoutLfs } : {}) },
  });
  const errors = [];
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await win.setViewportSize({ width: 1440, height: 860 });
  await win.waitForSelector('.row', { timeout: 20000 });
  await win.waitForTimeout(300);
  const shot = async (name) => {
    const file = path.join(outDir, `${name}.png`);
    await win.screenshot({ path: file });
    console.log('capture :', file);
  };
  try {
    await shot('00-ouverture');
    if (scenario) await require(path.resolve(scenario))(win, shot);
  } finally {
    await app.close();
    if (!keepArg) fs.rmSync(userData, { recursive: true, force: true });
    if (pathWithoutLfs) fs.rmSync(pathWithoutLfs, { recursive: true, force: true });
  }
  if (errors.length) {
    console.error('Erreurs dans le rendu :\n' + errors.join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
