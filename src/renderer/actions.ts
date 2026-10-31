import type { Commit, RepoSnapshot } from '../shared/types';
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
