import { useState } from 'react';
import type { RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { branchMenu, checkoutBranch } from '../actions';
import { useUi } from '../ui';
import { Icon } from './Icons';
import { RemotesSection } from './sidebar/RemotesSection';
import { Section } from './sidebar/Section';
import { TagsSection } from './sidebar/TagsSection';

export function Sidebar({ snap, onSelectCommit }: { snap: RepoSnapshot; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const repo = snap.path;
  const [filter, setFilter] = useState('');
  const match = (s: string) => s.toLowerCase().includes(filter.toLowerCase());

  const local = snap.branches.filter((b) => !b.remote && match(b.name));
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
      <RemotesSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
      <TagsSection snap={snap} match={match} />
      <Section title="Stashs" count={stashes.length} icon={<Icon.stash />}>
        {stashes.map((s) => (
          <div
            key={s.ref}
            className="side-item"
            title={s.ref}
            onContextMenu={(e) =>
              ui.openMenu(e, [
                { label: 'Appliquer', onClick: () => ui.run('Application du stash…', () => api.stashApply(repo, s.index, s.sha, false)) },
                { label: 'Appliquer et supprimer (pop)', onClick: () => ui.run('Pop…', () => api.stashApply(repo, s.index, s.sha, true)) },
                'separator',
                {
                  label: 'Supprimer…',
                  danger: true,
                  onClick: () =>
                    ui.ask({
                      title: 'Supprimer le stash',
                      message: `« ${s.message} » sera définitivement supprimé.`,
                      confirm: 'Supprimer',
                      danger: true,
                      onSubmit: () => ui.run('Suppression du stash…', () => api.stashDrop(repo, s.index, s.sha)),
                    }),
                },
              ])
            }
            onDoubleClick={() => ui.run('Application du stash…', () => api.stashApply(repo, s.index, s.sha, false))}
          >
            <span className="side-label">{s.message}</span>
          </div>
        ))}
      </Section>
    </nav>
  );
}
