---
name: run-arbor
description: Lancer Arbor dans Electron sans écran, ouvrir un dépôt, dérouler un scénario et regarder les captures. À utiliser pour vérifier tout changement visible de l'interface.
---

# Lancer et vérifier Arbor

1. Construire l'app (le script lance `dist/`, pas les sources) :
   ```bash
   npm run build
   ```
2. Préparer un dépôt de test (voir le skill `demo-repo`) :
   ```bash
   scripts/demo-repo.sh /tmp/arbor-demo            # ou --conflict
   ```
3. Écrire si besoin un scénario dans un fichier temporaire (hors du dépôt) :
   ```js
   // /tmp/scenario.cjs
   module.exports = async (win, shot) => {
     await win.click('.file:has-text("README.md")');
     await win.waitForSelector('.hunk');
     await shot('01-diff');
   };
   ```
   Sélecteurs utiles : `.row` (ligne du graphe), `.row.wip-row`, `.side-item:has-text("main")`, `.file`, `.link-btn:has-text("Tout indexer")`, `.commit-summary`, `.commit-box button.btn-primary`, `.menu-item:has-text("…")`, `.dialog button[type=submit]`, `.op-banner`, `.toast`.
   Clic droit : `win.click(sel, { button: 'right' })`.
4. Lancer :
   ```bash
   xvfb-run -a node scripts/ui-check.cjs /tmp/arbor-demo /tmp/arbor-shots /tmp/scenario.cjs
   ```
   Le script échoue si le rendu a levé une erreur JavaScript.
5. **Regarder chaque capture** avec l'outil de lecture d'images et vérifier le résultat attendu, puis contrôler l'état réel du dépôt (`git -C /tmp/arbor-demo log --oneline -5`, `git status`).

Playwright et Chromium sont préinstallés dans les sessions cloud : ne pas lancer `playwright install`.
