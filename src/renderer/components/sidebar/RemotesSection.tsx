import type { RepoSnapshot } from '../../../shared/types';
import { branchMenu, checkoutBranch } from '../../actions';
import { useUi } from '../../ui';
import { Icon } from '../Icons';
import { Section } from './Section';

/** Une section par remote (ses branches distantes filtrées), ou « Remotes » vide s'il n'y en a aucun. */
export function RemotesSection({ snap, match, onSelectCommit }: { snap: RepoSnapshot; match: (s: string) => boolean; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const repo = snap.path;
  const remotes = snap.remotes.map((r) => ({ name: r.name, branches: snap.branches.filter((b) => b.remote && b.name.startsWith(r.name + '/') && match(b.name)) }));

  return (
    <>
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
    </>
  );
}
