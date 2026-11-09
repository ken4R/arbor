import type { RepoSnapshot } from '../../../shared/types';
import { openSubmoduleTab, submoduleMenu, updateSubmodulesAction } from '../../actions';
import { SUBMODULE_STATE_LABEL, submoduleTitle, useSubmodules, useSubmodulesError } from '../../submodules';
import { useUi } from '../../ui';
import { Icon } from '../Icons';
import { Section } from './Section';

/**
 * Sous-modules de `.gitmodules` (section absente sans ce fichier). Double-clic : ouvre le sous-module dans un nouvel
 * onglet s'il est initialisé, sinon propose de l'initialiser.
 */
export function SubmodulesSection({ snap, match }: { snap: RepoSnapshot; match: (s: string) => boolean; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const subs = useSubmodules(snap);
  const error = useSubmodulesError(snap.path);
  if (!snap.features?.submodules) return null;
  const repo = snap.path;
  const shown = subs.filter((s) => match(s.path) || match(s.name));
  const actions = [{ icon: <Icon.refresh />, title: 'Initialiser et mettre à jour tous les sous-modules', onClick: () => void updateSubmodulesAction(ui, repo, null) }];

  return (
    <Section id="submodules" title="Sous-modules" count={shown.length} icon={<Icon.folder />} actions={actions}>
      {shown.map((s) => (
        <div
          key={s.path}
          className={`side-item submodule-item${s.initialized ? '' : ' side-item-off'}`}
          title={submoduleTitle(s)}
          onDoubleClick={() => {
            if (s.initialized) void openSubmoduleTab(ui, repo, s.path);
            else if (s.state === 'uninitialized') void updateSubmodulesAction(ui, repo, s.path);
          }}
          onContextMenu={(e) => ui.openMenu(e, submoduleMenu(ui, snap, s))}
        >
          <span className="side-label">{s.path}</span>
          {s.dirty && (
            <span className="submodule-dirty" title="Modifications non commitées" aria-label="modifié">
              ●
            </span>
          )}
          {s.state !== 'ok' && <span className={`submodule-state submodule-state-${s.state}`}>{SUBMODULE_STATE_LABEL[s.state]}</span>}
        </div>
      ))}
      {error && <div className="side-empty">{error}</div>}
      {!error && subs.length === 0 && <div className="side-empty">Aucun sous-module déclaré</div>}
    </Section>
  );
}
