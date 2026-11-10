import type { Remote, RepoSnapshot } from '../../../shared/types';
import { remoteOf } from '../../../shared/remotes';
import { branchMenu, checkoutBranch, fetchRemoteAction, remoteMenu } from '../../actions';
import { useUi } from '../../ui';
import { isMenuKey, menuAnchor } from '../ContextMenu';
import { dragDisabledReason, dropTargetProps, startRefDrag } from '../../refDrop';
import { useTabsBusy } from '../../tabs';
import { Icon, IconRemoteAdd } from '../Icons';
import { openAddRemoteDialog } from '../RemoteDialog';
import { Section } from './Section';

/** Infobulle d'un remote : URL de fetch, et URL de push si elle diffère. */
function remoteTooltip(r: Remote): string {
  if (!r.fetchUrl && !r.pushUrl) return `${r.name} : aucune URL configurée`;
  return [r.fetchUrl && `Fetch : ${r.fetchUrl}`, r.pushUrl && `Push : ${r.pushUrl}`].filter(Boolean).join('\n');
}

/**
 * Une section par remote (ses branches distantes filtrées), ou « Remotes » vide s'il n'y en a aucun. En-tête :
 * infobulle des URL, menu contextuel du remote, bouton Fetch ; le « + » (ajouter un remote) est sur la première.
 * Tout le bloc d'un remote est une cible de dépôt (pousser une branche locale) ; ses branches se glissent
 * (fusion, rebase) et s'ouvrent au clavier comme les branches locales.
 */
export function RemotesSection({ snap, match, onSelectCommit }: { snap: RepoSnapshot; match: (s: string) => boolean; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const repo = snap.path;
  // Chaque branche distante revient au plus long remote qui la préfixe (remotes `a` et `a/b`).
  const remotes = snap.remotes.map((r) => ({
    remote: r,
    branches: snap.branches.filter((b) => b.remote && remoteOf(snap.remotes, b.name) === r.name && match(b.name)),
  }));
  const draggable = !useTabsBusy() && !dragDisabledReason(snap);
  const add = { icon: <IconRemoteAdd />, title: 'Ajouter un remote…', onClick: () => openAddRemoteDialog(ui, snap) };

  return (
    <>
      {remotes.map(({ remote: r, branches }, i) => (
        <div key={r.name} title={remoteTooltip(r)} className="remote-drop" {...dropTargetProps(ui, snap, { kind: 'remote', name: r.name })}>
          <Section
            id={`remote:${r.name}`}
            title={r.name}
            count={branches.length}
            icon={<Icon.cloud />}
            onContextMenu={(e) => ui.openMenu(e, remoteMenu(ui, snap, r))}
            actions={[{ icon: <Icon.fetch />, title: `Fetch « ${r.name} »`, onClick: () => void fetchRemoteAction(ui, snap, r.name) }, ...(i === 0 ? [add] : [])]}
          >
            {branches.map((b) => (
              <div
                key={b.name}
                className="side-item"
                title={b.name}
                onClick={() => onSelectCommit(b.sha)}
                onDoubleClick={() => checkoutBranch(ui, repo, b.name)}
                onContextMenu={(e) => {
            // Clic droit ou touche Menu : un seul chemin (position sous l'élément quand l'événement vient du clavier).
            e.preventDefault();
            e.stopPropagation();
            const at = menuAnchor(e);
            ui.openMenuAt(at.x, at.y, branchMenu(ui, snap, b.name, true));
          }}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSelectCommit(b.sha);
                  else if (isMenuKey(e)) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    ui.openMenuAt(rect.left + 16, rect.bottom, branchMenu(ui, snap, b.name, true));
                  } else return;
                  e.preventDefault();
                }}
                draggable={draggable}
                onDragStart={(e) => startRefDrag(e, { name: b.name, remote: true })}
              >
                <span className="side-label">{b.name.slice(r.name.length + 1)}</span>
              </div>
            ))}
          </Section>
        </div>
      ))}
      {snap.remotes.length === 0 && (
        <Section id="remotes" title="Remotes" count={0} icon={<Icon.cloud />} actions={[add]}>
          <div className="side-empty">Aucun remote</div>
        </Section>
      )}
    </>
  );
}
