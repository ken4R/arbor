import { useEffect, useState } from 'react';
import type { RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { useUi } from '../ui';
import { Icon, Logo } from './Icons';

interface Props {
  repo: string;
  snap: RepoSnapshot | null;
  busy: string | null;
  onClose: () => void;
  onSwitch: (path: string) => void;
  onRefresh: () => void;
}

export function Toolbar({ repo, snap, busy, onClose, onSwitch, onRefresh }: Props) {
  const ui = useUi();
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    api.recentRepos().then(setRecent).catch(() => {});
  }, [repo]);

  const st = snap?.status;
  const hasRemote = (snap?.remotes.length ?? 0) > 0;
  const dirty = !!st && st.staged.length + st.unstaged.length > 0;

  const push = () => {
    if (st?.upstream) return ui.run('Push…', () => api.push(repo, false), 'Push terminé');
    ui.ask({
      title: 'Publier la branche',
      message: `La branche « ${st?.branch} » n'a pas encore de branche distante. Elle sera publiée sur origin.`,
      confirm: 'Publier',
      onSubmit: () => ui.run('Push…', () => api.push(repo, true), 'Branche publiée'),
    });
  };

  const newBranch = () =>
    ui.ask({
      title: 'Nouvelle branche',
      label: 'Nom de la branche',
      confirm: 'Créer',
      checkbox: { label: 'Basculer sur la nouvelle branche', initial: true },
      onSubmit: (name, co) => ui.run('Création de la branche…', () => api.createBranch(repo, name, 'HEAD', co)),
    });

  const repoMenu = (e: React.MouseEvent) =>
    ui.openMenu(e, [
      ...recent.filter((p) => p !== repo).map((p) => ({ label: p.split(/[\\/]/).pop()!, onClick: () => onSwitch(p) })),
      ...(recent.length > 1 ? (['separator'] as const) : []),
      { label: 'Ouvrir un autre dépôt…', onClick: async () => { const p = await api.openRepoDialog(); if (p) onSwitch(p); } },
      { label: 'Fermer le dépôt', onClick: onClose },
    ]);

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <Logo />
        <button className="repo-switch" onClick={repoMenu}>
          <span className="repo-name">{snap?.name ?? repo.split(/[\\/]/).pop()}</span>
          <span className="repo-branch">{st ? st.branch ?? 'HEAD détachée' : ''}</span>
        </button>
      </div>
      <div className="toolbar-actions">
        <ToolButton label="Fetch" icon={<Icon.fetch />} disabled={!hasRemote || !!busy} onClick={() => ui.run('Fetch…', () => api.fetch(repo), 'Fetch terminé')} />
        <ToolButton label="Pull" icon={<Icon.pull />} badge={st?.behind} disabled={!st?.upstream || !!busy} onClick={() => ui.run('Pull…', () => api.pull(repo), 'Pull terminé')} />
        <ToolButton label="Push" icon={<Icon.push />} badge={st?.ahead} disabled={!hasRemote || !st?.branch || !!busy} onClick={push} />
        <span className="toolbar-sep" />
        <ToolButton label="Branche" icon={<Icon.branch />} disabled={!snap?.head || !!busy} onClick={newBranch} />
        <ToolButton
          label="Stash"
          icon={<Icon.stash />}
          disabled={!dirty || !!busy}
          onClick={() =>
            ui.ask({
              title: 'Mettre de côté les modifications',
              label: 'Message (facultatif)',
              confirm: 'Stash',
              onSubmit: (msg) => ui.run('Stash…', () => api.stashSave(repo, msg)),
            })
          }
        />
        <ToolButton label="Pop" icon={<Icon.pop />} disabled={!snap?.stashes.length || !!busy} onClick={() => ui.run('Pop…', () => api.stashApply(repo, 0, true))} />
      </div>
      <div className="toolbar-right">
        {busy && <span className="busy"><span className="spinner" />{busy}</span>}
        <button className="icon-btn" title="Rafraîchir" onClick={onRefresh}>
          <Icon.refresh />
        </button>
      </div>
    </header>
  );
}

function ToolButton(props: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean; badge?: number }) {
  return (
    <button className="tool-btn" onClick={props.onClick} disabled={props.disabled}>
      <span className="tool-icon">
        {props.icon}
        {!!props.badge && <span className="tool-badge">{props.badge}</span>}
      </span>
      <span>{props.label}</span>
    </button>
  );
}
