import { useEffect, useState } from 'react';
import type { RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import {
  canFetch,
  canNewBranch,
  canPull,
  canPush,
  canStashPop,
  canStashSave,
  fetchAction,
  newBranchAction,
  pullAction,
  pushAction,
  stashPopAction,
  stashSaveAction,
} from '../actions';
import { useUi } from '../ui';
import { Icon, Logo } from './Icons';

interface Props {
  repo: string;
  snap: RepoSnapshot | null;
  busy: string | null;
  onClose: () => void;
  onSwitch: (path: string) => void;
  onRefresh: () => void;
  /** Rafraîchissement automatique quand le dépôt change hors d'Arbor. */
  autoRefresh?: boolean;
  onToggleAuto?: () => void;
}

export function Toolbar({ repo, snap, busy, onClose, onSwitch, onRefresh, autoRefresh, onToggleAuto }: Props) {
  const ui = useUi();
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    api.recentRepos().then(setRecent).catch(() => {});
  }, [repo]);

  const st = snap?.status;
  // Instantané du dépôt affiché seulement : jamais d'action sur l'ancien dépôt pendant un changement.
  const current = snap && snap.path === repo ? snap : null;

  const repoMenu = (e: React.MouseEvent) =>
    ui.openMenu(e, [
      ...recent.filter((p) => p !== repo).map((p) => ({ label: p.split(/[\\/]/).pop()!, onClick: () => onSwitch(p) })),
      ...(recent.length > 1 ? (['separator'] as const) : []),
      { label: 'Ouvrir un autre dépôt…', onClick: () => ui.run('Ouverture…', async () => { const p = await api.openRepoDialog(); if (p) onSwitch(p); }) },
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
        <ToolButton label="Fetch" icon={<Icon.fetch />} disabled={!canFetch(current) || !!busy} onClick={() => current && fetchAction(ui, current)} />
        <ToolButton label="Pull" icon={<Icon.pull />} badge={st?.behind} disabled={!canPull(current) || !!busy} onClick={() => current && pullAction(ui, current)} />
        <ToolButton label="Push" icon={<Icon.push />} badge={st?.ahead} disabled={!canPush(current) || !!busy} onClick={() => current && pushAction(ui, current)} />
        <span className="toolbar-sep" />
        <ToolButton label="Branche" icon={<Icon.branch />} disabled={!canNewBranch(current) || !!busy} onClick={() => current && newBranchAction(ui, current)} />
        <ToolButton label="Stash" icon={<Icon.stash />} disabled={!canStashSave(current) || !!busy} onClick={() => current && stashSaveAction(ui, current)} />
        <ToolButton label="Pop" icon={<Icon.pop />} disabled={!canStashPop(current) || !!busy} onClick={() => current && stashPopAction(ui, current)} />
      </div>
      <div className="toolbar-right">
        {busy && <span className="busy"><span className="spinner" />{busy}</span>}
        {onToggleAuto && (
          <label
            className="auto-refresh"
            title={autoRefresh ? 'Rafraîchissement automatique activé : Arbor suit les changements faits hors de l\'application' : 'Rafraîchissement automatique désactivé'}
          >
            <input type="checkbox" role="switch" checked={!!autoRefresh} onChange={onToggleAuto} />
            <span className="auto-refresh-track" aria-hidden="true" />
            <span>Auto</span>
          </label>
        )}
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
