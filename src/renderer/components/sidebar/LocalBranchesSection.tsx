import type { RepoSnapshot } from '../../../shared/types';
import { branchMenu, checkoutBranch } from '../../actions';
import { useUi } from '../../ui';
import { Icon } from '../Icons';
import { Section } from './Section';

/**
 * Branches locales filtrées. Clic : sélectionne le commit ; double-clic : checkout (sauf branche courante) ; la branche
 * courante affiche son avance et son retard sur sa branche distante.
 */
export function LocalBranchesSection({ snap, match, onSelectCommit }: { snap: RepoSnapshot; match: (s: string) => boolean; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const repo = snap.path;
  const local = snap.branches.filter((b) => !b.remote && match(b.name));

  return (
    <Section id="local" title="Local" count={local.length} icon={<Icon.computer />}>
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
  );
}
