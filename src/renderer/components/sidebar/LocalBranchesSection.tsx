import type { RepoSnapshot } from '../../../shared/types';
import { branchMenu, checkoutBranch } from '../../actions';
import { useUi } from '../../ui';
import { isMenuKey, menuAnchor } from '../ContextMenu';
import { dragDisabledReason, dropTargetProps, startRefDrag } from '../../refDrop';
import { useTabsBusy } from '../../tabs';
import { Icon } from '../Icons';
import { Section } from './Section';

/**
 * Branches locales filtrées. Clic : sélectionne le commit ; double-clic : checkout (sauf branche courante) ; la branche
 * courante affiche son avance et son retard sur sa branche distante. Chaque branche se glisse (sur une autre branche,
 * un commit, un remote) et reçoit un dépôt ; au clavier : Tab, Entrée = sélection, Maj+F10 ou touche Menu = menu.
 */
export function LocalBranchesSection({ snap, match, onSelectCommit }: { snap: RepoSnapshot; match: (s: string) => boolean; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const repo = snap.path;
  const local = snap.branches.filter((b) => !b.remote && match(b.name));
  const draggable = !useTabsBusy() && !dragDisabledReason(snap);

  return (
    <Section id="local" title="Local" count={local.length} icon={<Icon.computer />}>
      {local.map((b) => (
        <div
          key={b.name}
          className={`side-item${b.current ? ' current' : ''}`}
          title={b.upstream ? `Suit ${b.upstream}` : 'Pas de branche distante'}
          onClick={() => onSelectCommit(b.sha)}
          onDoubleClick={() => !b.current && checkoutBranch(ui, repo, b.name)}
          onContextMenu={(e) => {
            // Clic droit ou touche Menu : un seul chemin (position sous l'élément quand l'événement vient du clavier).
            e.preventDefault();
            e.stopPropagation();
            const at = menuAnchor(e);
            ui.openMenuAt(at.x, at.y, branchMenu(ui, snap, b.name, false));
          }}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSelectCommit(b.sha);
            else if (isMenuKey(e)) {
              const r = e.currentTarget.getBoundingClientRect();
              ui.openMenuAt(r.left + 16, r.bottom, branchMenu(ui, snap, b.name, false));
            } else return;
            e.preventDefault();
          }}
          draggable={draggable}
          onDragStart={(e) => startRefDrag(e, { name: b.name, remote: false })}
          {...dropTargetProps(ui, snap, { kind: 'branch', name: b.name, remote: false })}
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
