import { useState } from 'react';
import type { RepoSnapshot } from '../../shared/types';
import { LocalBranchesSection } from './sidebar/LocalBranchesSection';
import { RemotesSection } from './sidebar/RemotesSection';
import { StashesSection } from './sidebar/StashesSection';
import { SubmodulesSection } from './sidebar/SubmodulesSection';
import { LfsSection } from './sidebar/LfsSection';
import { TagsSection } from './sidebar/TagsSection';

/** Barre latérale : filtre commun puis sections de `sidebar/` (même signature : snap, match, onSelectCommit). */
export function Sidebar({ snap, onSelectCommit }: { snap: RepoSnapshot; onSelectCommit: (sha: string) => void }) {
  const [filter, setFilter] = useState('');
  const match = (s: string) => s.toLowerCase().includes(filter.toLowerCase());

  return (
    <nav className="sidebar">
      <input className="sidebar-filter" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <LocalBranchesSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
      <RemotesSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
      <TagsSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
      <StashesSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
      <SubmodulesSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
      <LfsSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
    </nav>
  );
}
