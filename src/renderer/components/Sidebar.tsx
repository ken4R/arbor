import { useMemo, useState } from 'react';
import type { RepoSnapshot } from '../../shared/types';
import { VIEW_TEXT_LIMIT } from '../../shared/session';
import { getTabView, patchTabView, withCollapsed } from '../tabs';
import { LocalBranchesSection } from './sidebar/LocalBranchesSection';
import { RemotesSection } from './sidebar/RemotesSection';
import { SectionStateContext, type SectionState } from './sidebar/Section';
import { StashesSection } from './sidebar/StashesSection';
import { TagsSection } from './sidebar/TagsSection';

/**
 * Barre latérale : filtre commun puis sections de `sidebar/` (même signature : snap, match, onSelectCommit).
 * Le filtre et les sections repliées appartiennent à l'onglet `tabId` (relus au remontage, enregistrés en session).
 */
export function Sidebar({ tabId, snap, onSelectCommit }: { tabId: number; snap: RepoSnapshot; onSelectCommit: (sha: string) => void }) {
  const [filter, setFilterState] = useState(() => getTabView(tabId).filter);
  const [collapsed, setCollapsedState] = useState(() => getTabView(tabId).collapsed);
  const match = (s: string) => s.toLowerCase().includes(filter.toLowerCase());

  const setFilter = (value: string) => {
    setFilterState(value);
    patchTabView(tabId, { filter: value });
  };
  const sections: SectionState = useMemo(
    () => ({
      collapsed,
      setCollapsed: (id, value, byDefault) => {
        const next = withCollapsed(collapsed, id, value, byDefault);
        setCollapsedState(next);
        patchTabView(tabId, { collapsed: next });
      },
    }),
    [collapsed, tabId],
  );

  // Sections hors du fournisseur dans le JSX : les lignes de sections restent faciles à compléter.
  const content = (
    <nav className="sidebar">
      <input className="sidebar-filter" placeholder="Filtrer…" maxLength={VIEW_TEXT_LIMIT} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <LocalBranchesSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
      <RemotesSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
      <TagsSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
      <StashesSection snap={snap} match={match} onSelectCommit={onSelectCommit} />
    </nav>
  );
  return <SectionStateContext.Provider value={sections}>{content}</SectionStateContext.Provider>;
}
