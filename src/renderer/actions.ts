import type { Commit, RepoSnapshot, Tag } from '../shared/types';
import type { Remote } from '../shared/types';
import { remoteOf } from '../shared/remotes';
import { openAddRemoteDialog, openEditRemoteDialog } from './components/RemoteDialog';
import { api } from './api';
import type { MenuItem } from './components/ContextMenu';
import { openDeleteTagDialog, openTagDialog, pushTagAction } from './components/TagDialog';
import type { Ui } from './ui';
import { openRebaseDialog } from './components/RebaseDialog';
import type { Submodule } from '../shared/types';
import { openRepoTab } from './tabs';
import type { LfsFile, LfsPattern } from '../shared/types';
import { lfsIncludeError, lfsPatternError } from '../shared/lfs';
import { bumpLfsFiles } from './lfs';

export function checkoutBranch(ui: Ui, repo: string, name: string) {
  return ui.run(`Checkout de ${name}…`, () => api.checkout(repo, name));
}

export function branchMenu(ui: Ui, snap: RepoSnapshot, name: string, remote: boolean): MenuItem[] {
  const repo = snap.path;
  const current = snap.status.branch;
  const isCurrent = !remote && name === current;
  return [
    { label: `Checkout « ${name} »`, disabled: isCurrent, onClick: () => checkoutBranch(ui, repo, name) },
    'separator',
    {
      label: `Fusionner « ${name} » dans « ${current ?? 'HEAD'} »`,
      disabled: isCurrent,
      onClick: () => ui.run('Fusion…', () => api.merge(repo, name), 'Fusion terminée'),
    },
    {
      label: `Rebaser « ${current ?? 'HEAD'} » sur « ${name} »`,
      disabled: isCurrent || !current,
      onClick: () => ui.run('Rebase…', () => api.rebase(repo, name), 'Rebase terminé'),
    },
    {
      label: `Rebase interactif de « ${current ?? 'HEAD'} » sur « ${name} »…`,
      disabled: isCurrent || !snap.head || snap.status.state !== 'clean',
      onClick: () => openRebaseDialog(ui, snap, name, `« ${name} »`),
    },
    'separator',
    {
      label: 'Créer une branche ici…',
      onClick: () =>
        ui.ask({
          title: 'Nouvelle branche',
          message: `À partir de « ${name} »`,
          label: 'Nom de la branche',
          confirm: 'Créer',
          checkbox: { label: 'Basculer sur la nouvelle branche', initial: true },
          onSubmit: (n, co) => ui.run('Création…', () => api.createBranch(repo, n, name, co)),
        }),
    },
    ...(remote
      ? []
      : ([
          'separator',
          {
            label: `Supprimer « ${name} »`,
            danger: true,
            disabled: isCurrent,
            onClick: () =>
              ui.ask({
                title: 'Supprimer la branche',
                message: `La branche locale « ${name} » sera supprimée.`,
                confirm: 'Supprimer',
                danger: true,
                checkbox: { label: 'Forcer (même si non fusionnée)', initial: false },
                onSubmit: (_v, force) => ui.run('Suppression…', () => api.deleteBranch(repo, name, force)),
              }),
          },
        ] as MenuItem[])),
  ];
}

export function commitMenu(ui: Ui, snap: RepoSnapshot, c: Commit): MenuItem[] {
  const repo = snap.path;
  const short = c.sha.slice(0, 7);
  const reset = (mode: 'soft' | 'mixed' | 'hard') =>
    ui.ask({
      title: `Reset ${mode}`,
      message:
        mode === 'hard'
          ? `La branche courante sera ramenée à ${short} et TOUTES les modifications non commitées seront perdues.`
          : `La branche courante sera ramenée à ${short}${mode === 'soft' ? ', les changements restent indexés.' : ', les changements restent dans le répertoire de travail.'}`,
      confirm: 'Reset',
      danger: mode === 'hard',
      onSubmit: () => ui.run('Reset…', () => api.reset(repo, c.sha, mode)),
    });
  return [
    {
      label: 'Créer une branche ici…',
      onClick: () =>
        ui.ask({
          title: 'Nouvelle branche',
          message: `À partir de ${short}`,
          label: 'Nom de la branche',
          confirm: 'Créer',
          checkbox: { label: 'Basculer sur la nouvelle branche', initial: true },
          onSubmit: (n, co) => ui.run('Création…', () => api.createBranch(repo, n, c.sha, co)),
        }),
    },
    {
      label: 'Créer un tag ici…',
      onClick: () => openTagDialog(ui, snap, c.sha, `${short} « ${c.subject} »`),
    },
    { label: 'Checkout de ce commit (HEAD détachée)', onClick: () => ui.run('Checkout…', () => api.checkout(repo, c.sha)) },
    'separator',
    { label: 'Cherry-pick dans la branche courante', disabled: c.sha === snap.head, onClick: () => ui.run('Cherry-pick…', () => api.cherryPick(repo, c.sha)) },
    { label: 'Annuler ce commit (revert)', onClick: () => ui.run('Revert…', () => api.revert(repo, c.sha)) },
    {
      label: 'Rebase interactif à partir d’ici…',
      disabled: c.sha === snap.head || !snap.head || snap.status.state !== 'clean',
      onClick: () => openRebaseDialog(ui, snap, c.sha, short, true),
    },
    'separator',
    { label: 'Reset soft vers ce commit', onClick: () => reset('soft') },
    { label: 'Reset mixed vers ce commit', onClick: () => reset('mixed') },
    { label: 'Reset hard vers ce commit', danger: true, onClick: () => reset('hard') },
    'separator',
    { label: 'Copier le SHA', onClick: () => navigator.clipboard.writeText(c.sha) },
  ];
}

// Actions Git de la barre d'outils, réutilisables (palette de commandes, raccourcis). Les prédicats `can*`
// disent si l'action a un sens pour cet instantané ; l'appelant ajoute ses propres conditions (opération en cours).

export const canFetch = (snap: RepoSnapshot | null) => !!snap && snap.remotes.length > 0;
export const canPull = (snap: RepoSnapshot | null) => !!snap?.status.upstream;
export const canPush = (snap: RepoSnapshot | null) => !!snap && snap.remotes.length > 0 && !!snap.status.branch;
export const canNewBranch = (snap: RepoSnapshot | null) => !!snap?.head;
export const canStashSave = (snap: RepoSnapshot | null) => !!snap && snap.status.staged.length + snap.status.unstaged.length > 0;
export const canStashPop = (snap: RepoSnapshot | null) => !!snap?.stashes.length;

export function fetchAction(ui: Ui, snap: RepoSnapshot) {
  return ui.run('Fetch…', () => api.fetch(snap.path), 'Fetch terminé');
}

export function pullAction(ui: Ui, snap: RepoSnapshot) {
  return ui.run('Pull…', () => api.pull(snap.path), 'Pull terminé');
}

/** Push ; une branche sans branche distante est publiée après confirmation. */
export function pushAction(ui: Ui, snap: RepoSnapshot) {
  const repo = snap.path;
  const st = snap.status;
  if (st.upstream) return void ui.run('Push…', () => api.push(repo, false), 'Push terminé');
  ui.ask({
    title: 'Publier la branche',
    message: `La branche « ${st.branch} » n'a pas encore de branche distante. Elle sera publiée sur ${snap.remotes.some((r) => r.name === 'origin') ? 'origin' : snap.remotes[0]?.name}.`,
    confirm: 'Publier',
    onSubmit: () => ui.run('Push…', () => api.push(repo, true), 'Branche publiée'),
  });
}

/** Nouvelle branche à partir de HEAD (nom demandé). */
export function newBranchAction(ui: Ui, snap: RepoSnapshot) {
  ui.ask({
    title: 'Nouvelle branche',
    label: 'Nom de la branche',
    confirm: 'Créer',
    checkbox: { label: 'Basculer sur la nouvelle branche', initial: true },
    onSubmit: (name, co) => ui.run('Création de la branche…', () => api.createBranch(snap.path, name, 'HEAD', co)),
  });
}

/** Met de côté les modifications (message facultatif demandé). */
export function stashSaveAction(ui: Ui, snap: RepoSnapshot) {
  ui.ask({
    title: 'Mettre de côté les modifications',
    label: 'Message (facultatif)',
    optional: true,
    confirm: 'Stash',
    onSubmit: (msg) => ui.run('Stash…', () => api.stashSave(snap.path, msg)),
  });
}

/** Réapplique et supprime le dernier stash. */
export function stashPopAction(ui: Ui, snap: RepoSnapshot) {
  if (!snap.stashes.length) return;
  return ui.run('Pop…', () => api.stashApply(snap.path, 0, snap.stashes[0].sha, true));
}

// remotes

/** Menu d'un remote (en-tête de sa section dans la barre latérale). */
export function remoteMenu(ui: Ui, snap: RepoSnapshot, remote: Remote): MenuItem[] {
  const repo = snap.path;
  const name = remote.name;
  const url = remote.fetchUrl ?? remote.pushUrl;
  const remoteBranches = snap.branches.filter((b) => b.remote && remoteOf(snap.remotes, b.name) === name && !b.name.endsWith('/HEAD')).length;
  return [
    { label: `Fetch « ${name} »`, onClick: () => fetchRemoteAction(ui, snap, name) },
    { label: `Prune « ${name} »`, onClick: () => pruneRemoteAction(ui, snap, name) },
    'separator',
    { label: "Modifier l'URL…", onClick: () => openEditRemoteDialog(ui, snap, name) },
    {
      label: 'Renommer…',
      onClick: () =>
        ui.ask({
          title: `Renommer le remote « ${name} »`,
          message: 'Les branches distantes et la configuration de suivi des branches locales suivent le nouveau nom.',
          label: 'Nouveau nom',
          initial: name,
          confirm: 'Renommer',
          onSubmit: (n) => {
            if (n !== name) void ui.run('Renommage du remote…', () => api.renameRemote(repo, name, n), `Remote renommé en « ${n} »`);
          },
        }),
    },
    {
      label: 'Supprimer…',
      danger: true,
      onClick: () =>
        ui.ask({
          title: `Supprimer le remote « ${name} »`,
          message:
            `Le remote sera retiré de la configuration, avec ses ${remoteBranches} branche${remoteBranches > 1 ? 's' : ''} distante${remoteBranches > 1 ? 's' : ''} ` +
            'et le suivi des branches locales qui s’y rattachent. Les commits et les branches locales sont conservés.',
          confirm: 'Supprimer',
          danger: true,
          onSubmit: () => void ui.run('Suppression du remote…', () => api.removeRemote(repo, name), `Remote « ${name} » supprimé`),
        }),
    },
    'separator',
    { label: "Copier l'URL", disabled: !url, onClick: () => url && void navigator.clipboard.writeText(url) },
    'separator',
    { label: 'Ajouter un remote…', onClick: () => openAddRemoteDialog(ui, snap) },
  ];
}

export function fetchRemoteAction(ui: Ui, snap: RepoSnapshot, name: string) {
  return ui.run(`Fetch de ${name}…`, () => api.fetchRemote(snap.path, name), `Fetch de « ${name} » terminé`);
}

export function pruneRemoteAction(ui: Ui, snap: RepoSnapshot, name: string) {
  return ui.run(`Prune de ${name}…`, () => api.pruneRemote(snap.path, name), `Prune de « ${name} » terminé`);
}

// tags

/** Checkout d'un tag par son nom complet (`refs/tags/<nom>`), jamais ambigu avec une branche du même nom. */
export function checkoutTag(ui: Ui, repo: string, tag: Tag) {
  if (tag.sha === null) return;
  return ui.run(`Checkout du tag ${tag.name}…`, () => api.checkoutTag(repo, tag.name));
}

/** Menu contextuel d'un tag (barre latérale, badge du graphe). */
export function tagMenu(ui: Ui, snap: RepoSnapshot, tag: Tag): MenuItem[] {
  const repo = snap.path;
  const pushes: MenuItem[] = snap.remotes.length
    ? snap.remotes.map((r) => ({ label: `Pousser vers « ${r.name} »`, onClick: () => void pushTagAction(ui, repo, r.name, tag.name) }))
    : [{ label: 'Pousser (aucun remote)', disabled: true, onClick: () => {} }];
  return [
    { label: `Checkout « ${tag.name} » (HEAD détachée)`, disabled: tag.sha === null, onClick: () => void checkoutTag(ui, repo, tag) },
    'separator',
    ...pushes,
    'separator',
    { label: 'Supprimer…', danger: true, onClick: () => openDeleteTagDialog(ui, snap, tag) },
    'separator',
    { label: 'Copier le nom', onClick: () => void navigator.clipboard.writeText(tag.name) },
  ];
}

// sous-modules

/** Ouvre un sous-module initialisé dans un nouvel onglet (chemin revérifié par le processus principal). */
export function openSubmoduleTab(ui: Ui, repo: string, path: string) {
  return ui.run(
    'Ouverture du sous-module…',
    async () => {
      const top = await api.openSubmodule(repo, path);
      if (!openRepoTab(top, 'new')) throw new Error("Impossible d'ouvrir un onglet pendant une autre opération.");
    },
    undefined,
    { allowOpen: true },
  );
}

/** Initialise un sous-module non initialisé, ou tous ceux qui ne le sont pas si `path` est null (aucun n'est déplacé). */
export function initSubmodulesAction(ui: Ui, repo: string, path: string | null) {
  const what = path ? `« ${path} »` : 'des sous-modules manquants';
  return ui.run(`Initialisation ${path ? 'de ' : ''}${what}…`, () => api.submoduleInit(repo, path), path ? `Sous-module « ${path} » initialisé` : 'Sous-modules initialisés');
}

export function syncSubmodulesAction(ui: Ui, repo: string) {
  return ui.run('Synchronisation des URL…', () => api.submoduleSync(repo), 'URL des sous-modules synchronisées');
}

/** Remet le sous-module sur le commit attendu par le dépôt parent, après confirmation. */
export function resetSubmoduleAction(ui: Ui, repo: string, path: string, expected: string | null) {
  if (!expected) return;
  ui.ask({
    title: 'Revenir au commit attendu',
    message:
      `« ${path} » sera extrait sur le commit attendu ${expected.slice(0, 7)} (HEAD détachée dans le sous-module ; ses propres sous-modules ne sont pas modifiés). ` +
      'Le commit actuellement extrait reste accessible par le reflog du sous-module ; des modifications locales qui gêneraient le checkout le feront échouer.',
    confirm: 'Revenir au commit attendu',
    danger: true,
    onSubmit: () => void ui.run('Retour au commit attendu…', () => api.submoduleReset(repo, path, expected), `« ${path} » est revenu au commit attendu`),
  });
}

/** Menu contextuel d'un sous-module (barre latérale). */
export function submoduleMenu(ui: Ui, snap: RepoSnapshot, sub: Submodule): MenuItem[] {
  const repo = snap.path;
  const unstaged = snap.status.unstaged.some((f) => f.path === sub.path);
  return [
    { label: 'Ouvrir dans un nouvel onglet', disabled: !sub.initialized, onClick: () => void openSubmoduleTab(ui, repo, sub.path) },
    { label: 'Voir les modifications', disabled: !unstaged, onClick: () => ui.showDiff({ kind: 'working', path: sub.path, staged: false }) },
    'separator',
    // Seul un sous-module non initialisé s'initialise ; un « autre commit extrait » passe par l'entrée confirmée ci-dessous.
    { label: 'Initialiser', disabled: sub.state !== 'uninitialized', onClick: () => void initSubmodulesAction(ui, repo, sub.path) },
    {
      label: 'Revenir au commit attendu…',
      danger: true,
      disabled: sub.state !== 'changed' || !sub.expected,
      onClick: () => resetSubmoduleAction(ui, repo, sub.path, sub.expected),
    },
    'separator',
    { label: 'Synchroniser les URL', onClick: () => void syncSubmodulesAction(ui, repo) },
    { label: 'Copier le chemin', onClick: () => void navigator.clipboard.writeText(sub.path) },
    { label: "Copier l'URL", disabled: !sub.url, onClick: () => sub.url && void navigator.clipboard.writeText(sub.url) },
  ];
}

// lfs

/** Demande un motif et le fait suivre par LFS (règle écrite dans `.gitattributes`). */
export function lfsTrackAction(ui: Ui, repo: string, initial = '') {
  ui.ask({
    title: 'Suivre un motif LFS',
    message:
      'Les fichiers correspondants seront stockés dans LFS à leur prochain ajout (les fichiers déjà commités ne sont pas convertis). ' +
      'La règle est ajoutée au .gitattributes racine, à commiter.',
    label: 'Motif (ex. *.psd, assets/**/*.png)',
    initial,
    confirm: 'Suivre',
    onSubmit: (pattern) =>
      void ui.run(
        'Suivi du motif LFS…',
        async () => {
          const err = lfsPatternError(pattern);
          if (err) throw new Error(err);
          await api.lfsTrack(repo, pattern, false);
          bumpLfsFiles();
        },
        `Motif « ${pattern} » suivi par LFS`,
      ),
  });
}

/** Retire un motif du `.gitattributes` racine, après confirmation. */
export function lfsUntrackAction(ui: Ui, repo: string, pattern: string) {
  ui.ask({
    title: 'Ne plus suivre le motif',
    message:
      `« ${pattern} » sera retiré du .gitattributes racine : les prochaines versions des fichiers correspondants seront stockées directement dans Git. ` +
      'Les versions déjà commitées restent dans LFS.',
    confirm: 'Ne plus suivre',
    onSubmit: () =>
      void ui.run(
        'Retrait du motif LFS…',
        async () => {
          await api.lfsTrack(repo, pattern, true);
          bumpLfsFiles();
        },
        `Motif « ${pattern} » retiré`,
      ),
  });
}

export function lfsFetchAction(ui: Ui, repo: string) {
  return ui.run(
    'Téléchargement des objets LFS…',
    async () => {
      await api.lfsFetch(repo);
      bumpLfsFiles();
    },
    'Objets LFS téléchargés',
  );
}

/** Télécharge et extrait les fichiers LFS : tous (`paths` null) ou ceux donnés. */
export function lfsPullAction(ui: Ui, repo: string, paths: string[] | null) {
  const one = paths?.length === 1 ? paths[0] : null;
  return ui.run(
    one ? `Récupération de « ${one} »…` : 'Récupération des fichiers LFS…',
    async () => {
      await api.lfsPull(repo, paths);
      bumpLfsFiles();
    },
    one ? `« ${one} » récupéré` : 'Fichiers LFS récupérés',
  );
}

/** Menu d'un motif LFS (barre latérale) : seul un motif suivi du `.gitattributes` racine peut être retiré. */
export function lfsPatternMenu(ui: Ui, repo: string, p: LfsPattern, installed: boolean): MenuItem[] {
  return [
    {
      label: 'Ne plus suivre…',
      disabled: !installed || p.excluded || p.source !== '.gitattributes',
      onClick: () => lfsUntrackAction(ui, repo, p.pattern),
    },
    { label: 'Copier le motif', onClick: () => void navigator.clipboard.writeText(p.pattern) },
  ];
}

/** Menu d'un fichier LFS (barre latérale). */
export function lfsFileMenu(ui: Ui, repo: string, f: LfsFile): MenuItem[] {
  return [
    { label: 'Récupérer le contenu', disabled: f.present || lfsIncludeError(f.path) !== null, onClick: () => void lfsPullAction(ui, repo, [f.path]) },
    'separator',
    { label: 'Copier le chemin', onClick: () => void navigator.clipboard.writeText(f.path) },
    { label: "Copier l'empreinte (oid)", onClick: () => void navigator.clipboard.writeText(f.oid) },
  ];
}
