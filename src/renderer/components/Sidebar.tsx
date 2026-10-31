import { useState } from 'react';
import type { RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { branchMenu, checkoutBranch } from '../actions';
import { useUi } from '../ui';
import { Icon } from './Icons';

export function Sidebar({ snap, onSelectCommit }: { snap: RepoSnapshot; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const repo = snap.path;
  const [filter, setFilter] = useState('');
  const match = (s: string) => s.toLowerCase().includes(filter.toLowerCase());

  const local = snap.branches.filter((b) => !b.remote && match(b.name));
  const remotes = snap.remotes.map((r) => ({ name: r, branches: snap.branches.filter((b) => b.remote && b.name.startsWith(r + '/') && match(b.name)) }));
  const tags = snap.tags.filter(match);
  const stashes = snap.stashes.filter((s) => match(s.message));

  return (
    <nav className="sidebar">
      <input className="sidebar-filter" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <Section title="Local" count={local.length} icon={<Icon.computer />}>
        {local.map((b) => (
          <div
            key={b.name}
            className={`side-item${b.current ? ' current' : ''}`}
            title={b.upstream ? `Suit ${b.upstream}` : 'Pas de branche distante'}
            onClick={() => onSelectCommit(b.sha)}
            onDoubleClick={() => !b.current && checkoutBranch(ui, repo, b.name)}
            onContextMenu={(e) => ui.openMenu(e, branchMenu(ui, snap, b.name, false))}
          >
            <span className="side-dot" />
            <span className="side-label">{b.name}</span>
            {b.current && snap.status.ahead + snap.status.behind > 0 && (
              <span className="side-meta">
                {snap.status.ahead > 0 && `↑${snap.status.ahead}`} {snap.status.behind > 0 && `↓${snap.status.behind}`}
              </span>
            )}
          </div>
        ))}
      </Section>
      {remotes.map((r) => (
        <Section key={r.name} title={r.name} count={r.branches.length} icon={<Icon.cloud />}>
          {r.branches.map((b) => (
            <div
              key={b.name}
              className="side-item"
              onClick={() => onSelectCommit(b.sha)}
              onDoubleClick={() => checkoutBranch(ui, repo, b.name)}
              onContextMenu={(e) => ui.openMenu(e, branchMenu(ui, snap, b.name, true))}
            >
              <span className="side-label">{b.name.slice(r.name.length + 1)}</span>
            </div>
          ))}
        </Section>
      ))}
      {snap.remotes.length === 0 && (
        <Section title="Remotes" count={0} icon={<Icon.cloud />}>
          <div className="side-empty">Aucun remote</div>
        </Section>
      )}
      <Section title="Tags" count={tags.length} icon={<Icon.tag />} collapsed>
        {tags.map((t) => (
          <div key={t} className="side-item" onDoubleClick={() => checkoutBranch(ui, repo, t)}>
            <span className="side-label">{t}</span>
          </div>
        ))}
      </Section>
      <Section title="Stashs" count={stashes.length} icon={<Icon.stash />}>
        {stashes.map((s) => (
          <div
            key={s.ref}
            className="side-item"
            title={s.ref}
            onContextMenu={(e) =>
              ui.openMenu(e, [
                { label: 'Appliquer', onClick: () => ui.run('Application du stash…', () => api.stashApply(repo, s.index, false)) },
                { label: 'Appliquer et supprimer (pop)', onClick: () => ui.run('Pop…', () => api.stashApply(repo, s.index, true)) },
                'separator',
                { label: 'Supprimer', danger: true, onClick: () => ui.run('Suppression du stash…', () => api.stashDrop(repo, s.index)) },
              ])
            }
            onDoubleClick={() => ui.run('Application du stash…', () => api.stashApply(repo, s.index, false))}
          >
            <span className="side-label">{s.message}</span>
          </div>
        ))}
      </Section>
    </nav>
  );
}

function Section(props: { title: string; count: number; icon: React.ReactNode; children: React.ReactNode; collapsed?: boolean }) {
  const [open, setOpen] = useState(!props.collapsed);
  return (
    <section className="side-section">
      <button className={`side-head${open ? ' open' : ''}`} onClick={() => setOpen(!open)}>
        <Icon.chevron />
        {props.icon}
        <span className="side-title">{props.title}</span>
        <span className="side-count">{props.count}</span>
      </button>
      {open && <div className="side-body">{props.children}</div>}
    </section>
  );
}
