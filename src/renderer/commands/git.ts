import type { RepoSnapshot } from '../../shared/types';
import {
  canFetch,
  canNewBranch,
  canPull,
  canPush,
  canStashPop,
  canStashSave,
  checkoutBranch,
  fetchAction,
  newBranchAction,
  pullAction,
  pushAction,
  stashPopAction,
  stashSaveAction,
} from '../actions';
import { api } from '../api';
import { registerCommands, type Command, type CommandContext } from '../commands';
import { getPreferences, updatePreferences } from '../prefs';

// Commandes Git de la palette : actions de la barre d'outils, opération en cours, dépôt, puis entrées
// dynamiques (branches, tags, dépôts récents, fichiers modifiés). Aucune commande Git nouvelle : tout passe
// par les actions existantes et `ui.run` / `ui.ask`.

/** Groupes des entrées dynamiques, utilisés par la palette pour les préfixes `@` (références) et `#` (fichiers). */
export const GROUP_BRANCHES = 'Branches';
export const GROUP_TAGS = 'Tags';
export const GROUP_FILES = 'Fichiers modifiés';
export const GROUP_RECENT = 'Dépôts récents';

const GROUP_GIT = 'Git';
const GROUP_REPO = 'Dépôt';

// Dépôts récents, relus par la palette à chaque ouverture (le fournisseur de commandes est synchrone).
let recentRepos: string[] = [];

export async function loadRecentRepos(): Promise<void> {
  try {
    recentRepos = await api.recentRepos();
  } catch {
    // liste des récents indisponible : la palette s'en passe
  }
}

const hasSnap = (c: CommandContext): c is CommandContext & { snap: RepoSnapshot; ui: NonNullable<CommandContext['ui']> } => !!c.snap && !!c.ui;
/** Dépôt chargé et aucune opération Git en cours (`busy`). */
const ready = (c: CommandContext): c is CommandContext & { snap: RepoSnapshot; ui: NonNullable<CommandContext['ui']> } => hasSnap(c) && !c.busy;
const inOperation = (c: CommandContext) => !!c.snap && c.snap.status.state !== 'clean';

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Affiche le panneau de travail (ligne WIP) et place le curseur dans le résumé du commit. */
function focusCommitSummary() {
  const focus = () => {
    const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('.commit-summary');
    if (!el) return false;
    el.focus();
    return true;
  };
  if (focus()) return;
  document.querySelector<HTMLElement>('.row.wip-row')?.click();
  // Le panneau est rendu au cycle suivant.
  requestAnimationFrame(() => requestAnimationFrame(() => void focus()));
}

function staticCommands(): Command[] {
  return [
    {
      id: 'git.fetch',
      title: 'Fetch',
      group: GROUP_GIT,
      keywords: ['récupérer', 'distant'],
      enabled: (c) => ready(c) && canFetch(c.snap),
      run: (c) => hasSnap(c) && void fetchAction(c.ui, c.snap),
    },
    {
      id: 'git.pull',
      title: 'Pull',
      group: GROUP_GIT,
      keywords: ['tirer', 'mettre à jour'],
      enabled: (c) => ready(c) && canPull(c.snap) && !inOperation(c),
      run: (c) => hasSnap(c) && void pullAction(c.ui, c.snap),
    },
    {
      id: 'git.push',
      title: 'Push',
      group: GROUP_GIT,
      keywords: ['pousser', 'publier'],
      enabled: (c) => ready(c) && canPush(c.snap),
      run: (c) => hasSnap(c) && pushAction(c.ui, c.snap),
    },
    {
      id: 'git.commit',
      title: 'Commit…',
      group: GROUP_GIT,
      keywords: ['valider', 'message'],
      enabled: (c) => ready(c),
      run: () => focusCommitSummary(),
    },
    {
      id: 'git.stash',
      title: 'Stash : mettre de côté les modifications',
      group: GROUP_GIT,
      keywords: ['remiser'],
      enabled: (c) => ready(c) && canStashSave(c.snap) && !inOperation(c),
      run: (c) => hasSnap(c) && stashSaveAction(c.ui, c.snap),
    },
    {
      id: 'git.pop',
      title: 'Pop : réappliquer le dernier stash',
      group: GROUP_GIT,
      keywords: ['stash', 'remise'],
      enabled: (c) => ready(c) && canStashPop(c.snap) && !inOperation(c),
      run: (c) => hasSnap(c) && void stashPopAction(c.ui, c.snap),
    },
    {
      id: 'git.newBranch',
      title: 'Nouvelle branche…',
      group: GROUP_GIT,
      keywords: ['créer', 'branch'],
      enabled: (c) => ready(c) && canNewBranch(c.snap),
      run: (c) => hasSnap(c) && newBranchAction(c.ui, c.snap),
    },
    {
      id: 'git.abort',
      title: 'Abandonner l’opération en cours',
      group: GROUP_GIT,
      keywords: ['annuler', 'fusion', 'merge', 'rebase', 'abort'],
      enabled: (c) => ready(c) && inOperation(c),
      run: (c) => {
        if (!hasSnap(c)) return;
        const { ui, snap } = c;
        ui.ask({
          title: 'Abandonner l’opération en cours',
          message: 'Le dépôt revient à son état d’avant l’opération. Les conflits déjà résolus seront perdus.',
          confirm: 'Abandonner',
          danger: true,
          onSubmit: () => ui.run('Abandon…', () => api.abort(snap.path)),
        });
      },
    },
    {
      id: 'git.continue',
      title: 'Continuer l’opération en cours',
      group: GROUP_GIT,
      keywords: ['fusion', 'merge', 'rebase', 'continue'],
      enabled: (c) => ready(c) && inOperation(c) && c.snap.status.conflicted.length === 0,
      run: (c) => hasSnap(c) && void c.ui.run('Continuer…', () => api.continueOp(c.snap.path)),
    },
    {
      id: 'git.refresh',
      title: 'Rafraîchir',
      group: GROUP_REPO,
      keywords: ['recharger', 'actualiser'],
      enabled: (c) => !!c.repo && !c.busy,
      run: (c) => c.app.refresh(),
    },
    {
      id: 'git.openRepo',
      title: 'Ouvrir un dépôt…',
      group: GROUP_REPO,
      keywords: ['dossier', 'projet'],
      enabled: (c) => !c.busy,
      run: (c) =>
        void api
          .openRepoDialog()
          .then((p) => p && c.app.openRepo(p))
          .catch((e: Error) => c.ui?.ask({ title: 'Ouverture impossible', message: e.message, confirm: 'OK', onSubmit: () => {} })),
    },
    {
      id: 'git.closeRepo',
      title: 'Fermer le dépôt',
      group: GROUP_REPO,
      enabled: (c) => !!c.repo && !c.busy,
      run: (c) => c.app.closeRepo(),
    },
    {
      id: 'git.toggleAutoRefresh',
      title: getPreferences().autoRefresh ? 'Désactiver le rafraîchissement automatique' : 'Activer le rafraîchissement automatique',
      group: GROUP_REPO,
      keywords: ['surveillance', 'basculer'],
      run: () => void updatePreferences({ autoRefresh: !getPreferences().autoRefresh }).catch(() => {}),
    },
  ];
}

function dynamicCommands(c: CommandContext): Command[] {
  const out: Command[] = [];
  if (hasSnap(c)) {
    const { snap } = c;
    for (const b of snap.branches) {
      if (b.current || (b.remote && b.name.endsWith('/HEAD'))) continue;
      out.push({
        id: `git.checkout:${b.remote ? 'remote' : 'local'}:${b.name}`,
        title: `Checkout ${b.name}`,
        group: GROUP_BRANCHES,
        keywords: [b.remote ? 'distante' : 'locale'],
        enabled: (x) => ready(x) && !inOperation(x),
        run: (x) => hasSnap(x) && void checkoutBranch(x.ui, x.snap.path, b.name),
      });
    }
    for (const tag of snap.tags) {
      const commit = snap.commits.find((cm) => cm.refs.some((r) => r.type === 'tag' && r.name === tag));
      if (!commit) continue;
      out.push({
        id: `git.tag:${tag}`,
        title: `Aller au tag ${tag}`,
        group: GROUP_TAGS,
        keywords: ['étiquette'],
        run: (x) => x.app.selectCommit(commit.sha),
      });
    }
    const st = snap.status;
    const files: [string, Parameters<CommandContext['app']['showDiff']>[0], string][] = [
      ...st.conflicted.map((f) => [f.path, { kind: 'working', path: f.path, staged: false, conflict: true }, 'en conflit'] as const),
      ...st.staged.map((f) => [f.path, { kind: 'working', path: f.path, oldPath: f.oldPath, staged: true }, 'indexé'] as const),
      ...st.unstaged.map((f) => [f.path, { kind: 'working', path: f.path, oldPath: f.oldPath, staged: false, untracked: f.status === '?' }, f.status === '?' ? 'non suivi' : 'modifié'] as const),
    ] as [string, Parameters<CommandContext['app']['showDiff']>[0], string][];
    for (const [path, target, label] of files) {
      out.push({
        id: `git.file:${label}:${path}`,
        title: path,
        group: GROUP_FILES,
        keywords: [label],
        run: (x) => x.app.showDiff(target),
      });
    }
  }
  for (const p of recentRepos) {
    if (p === c.repo) continue;
    out.push({
      id: `git.recent:${p}`,
      title: `Ouvrir ${baseName(p)}`,
      group: GROUP_RECENT,
      keywords: [p],
      run: (x) => x.app.openRepo(p),
    });
  }
  return out;
}

registerCommands('git', (c) => [...staticCommands(), ...dynamicCommands(c)]);
