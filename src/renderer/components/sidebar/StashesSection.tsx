import type { RepoSnapshot } from '../../../shared/types';
import { api } from '../../api';
import { useUi } from '../../ui';
import { Icon } from '../Icons';
import { Section } from './Section';

/**
 * Stashs filtrés par message. Double-clic : appliquer ; menu : appliquer, pop, supprimer (confirmé). `onSelectCommit`
 * garde la signature commune des sections (inutilisé ici).
 */
export function StashesSection({ snap, match }: { snap: RepoSnapshot; match: (s: string) => boolean; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const repo = snap.path;
  const stashes = snap.stashes.filter((s) => match(s.message));

  return (
    <Section id="stashes" title="Stashs" count={stashes.length} icon={<Icon.stash />}>
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
  );
}
