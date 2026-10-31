// Lance Arbor dans Electron (sans écran via xvfb-run), ouvre un dépôt et prend des captures.
// Usage : xvfb-run -a node scripts/ui-check.cjs <dépôt> <dossier-captures> [scénario.cjs]
// Un scénario exporte `async (win, shot) => {}` ; `shot(nom)` enregistre une capture.
const path = require('node:path');
const fs = require('node:fs');
const { _electron } = require('playwright');

const [repo, outDir, scenario] = process.argv.slice(2);
if (!repo || !outDir) {
  console.error('Usage : node scripts/ui-check.cjs <dépôt> <dossier-captures> [scénario.cjs]');
  process.exit(1);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  fs.mkdirSync(outDir, { recursive: true });
  const app = await _electron.launch({
    executablePath: require(path.join(root, 'node_modules/electron')),
    args: [root, '--no-sandbox', path.resolve(repo)],
    cwd: root,
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
  await shot('00-ouverture');
  if (scenario) await require(path.resolve(scenario))(win, shot);
  await app.close();
  if (errors.length) {
    console.error('Erreurs dans le rendu :\n' + errors.join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
