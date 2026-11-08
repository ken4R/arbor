import type { Commit, RepoSnapshot } from '../shared/types';
import type { Remote } from '../shared/types';
import { remoteOf } from '../shared/remotes';
import { openAddRemoteDialog, openEditRemoteDialog } from './components/RemoteDialog';
import { api } from './api';
import type { MenuItem } from './components/ContextMenu';
import type { Ui } from './ui';

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
      onClick: () =>
        ui.ask({ title: 'Nouveau tag', label: 'Nom du tag', confirm: 'Créer', onSubmit: (n) => ui.run('Tag…', () => api.createTag(repo, n, c.sha)) }),
    },
    { label: 'Checkout de ce commit (HEAD détachée)', onClick: () => ui.run('Checkout…', () => api.checkout(repo, c.sha)) },
    'separator',
    { label: 'Cherry-pick dans la branche courante', disabled: c.sha === snap.head, onClick: () => ui.run('Cherry-pick…', () => api.cherryPick(repo, c.sha)) },
    { label: 'Annuler ce commit (revert)', onClick: () => ui.run('Revert…', () => api.revert(repo, c.sha)) },
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
