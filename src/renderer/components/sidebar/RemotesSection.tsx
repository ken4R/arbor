import type { AccountInfo, Branch, Remote, RepoSnapshot } from '../../../shared/types';
import { remoteOf } from '../../../shared/remotes';
import { PROVIDERS } from '../../../shared/accounts';
import { redactUrlCredentials } from '../../../shared/remoteUrl';
import { useAccountForRemote } from '../../accounts';
import { branchMenu, checkoutBranch, fetchRemoteAction, remoteMenu } from '../../actions';
import { remoteHost } from '../../commands/accounts';
import { useUi, type Ui } from '../../ui';
import { isMenuKey, menuAnchor } from '../ContextMenu';
import { dragDisabledReason, dropTargetProps, startRefDrag } from '../../refDrop';
import { useTabsBusy } from '../../tabs';
import { Icon, IconRemoteAdd } from '../Icons';
import { openAddRemoteDialog } from '../RemoteDialog';
import { Section, type SectionAction } from './Section';

/**
 * Infobulle d'un remote : URL de fetch, et URL de push si elle diffère (identifiants masqués : une URL
 * `https://u:jeton@h` ne s'affiche jamais en clair), puis le compte associé à son hôte.
 */
function remoteTooltip(r: Remote, account: AccountInfo | null): string {
  if (!r.fetchUrl && !r.pushUrl) return `${r.name} : aucune URL configurée`;
  const lines = [r.fetchUrl && `Fetch : ${redactUrlCredentials(r.fetchUrl)}`, r.pushUrl && `Push : ${redactUrlCredentials(r.pushUrl)}`];
  if (account) {
    const state = account.secretUnreadable ? ', jeton illisible' : account.status === 'rejected' ? ', jeton refusé' : '';
    lines.push(`Compte : ${account.login} (${PROVIDERS[account.provider].label}${state})`);
  } else {
    const host = remoteHost(r.fetchUrl ?? r.pushUrl);
    if (host) lines.push(`Aucun compte pour ${host}`);
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * Une section par remote (ses branches distantes filtrées), ou « Remotes » vide s'il n'y en a aucun. En-tête :
 * infobulle des URL et du compte, pastille de compte, menu contextuel du remote, bouton Fetch ; le « + » (ajouter
 * un remote) est sur la première. Tout le bloc d'un remote est une cible de dépôt (pousser une branche locale) ; ses
 * branches se glissent (fusion, rebase) et s'ouvrent au clavier comme les branches locales.
 */
export function RemotesSection({ snap, match, onSelectCommit }: { snap: RepoSnapshot; match: (s: string) => boolean; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  // Chaque branche distante revient au plus long remote qui la préfixe (remotes `a` et `a/b`).
  const remotes = snap.remotes.map((r) => ({
    remote: r,
    branches: snap.branches.filter((b) => b.remote && remoteOf(snap.remotes, b.name) === r.name && match(b.name)),
  }));
  const draggable = !useTabsBusy() && !dragDisabledReason(snap);
  const add: SectionAction = { icon: <IconRemoteAdd />, title: 'Ajouter un remote…', onClick: () => openAddRemoteDialog(ui, snap) };

  return (
    <>
      {remotes.map(({ remote: r, branches }, i) => (
        <RemoteBlock key={r.name} ui={ui} snap={snap} remote={r} branches={branches} add={i === 0 ? add : null} draggable={draggable} onSelectCommit={onSelectCommit} />
      ))}
      {snap.remotes.length === 0 && (
        <Section id="remotes" title="Remotes" count={0} icon={<Icon.cloud />} actions={[add]}>
          <div className="side-empty">Aucun remote</div>
        </Section>
      )}
    </>
  );
}

/** Icône du remote, avec une pastille quand un compte est associé à son hôte (verte : ok ; rouge : jeton refusé). */
function RemoteIcon({ account }: { account: AccountInfo | null }) {
  return (
    <span className="remote-icon">
      <Icon.cloud />
      {account && <span className={`account-dot ${account.status}`} aria-label={`Compte ${account.login}`} />}
    </span>
  );
}

/** Bloc d'un remote : en-tête (pastille de compte, menu, Fetch, « + » éventuel) et ses branches distantes. */
function RemoteBlock({
  ui,
  snap,
  remote: r,
  branches,
  add,
  draggable,
  onSelectCommit,
}: {
  ui: Ui;
  snap: RepoSnapshot;
  remote: Remote;
  branches: Branch[];
  add: SectionAction | null;
  draggable: boolean;
  onSelectCommit: (sha: string) => void;
}) {
  const repo = snap.path;
  const account = useAccountForRemote(r);
  return (
    <div title={remoteTooltip(r, account)} className="remote-drop" {...dropTargetProps(ui, snap, { kind: 'remote', name: r.name })}>
      <Section
        id={`remote:${r.name}`}
        title={r.name}
        count={branches.length}
        icon={<RemoteIcon account={account} />}
        onContextMenu={(e) => ui.openMenu(e, remoteMenu(ui, snap, r))}
        actions={[{ icon: <Icon.fetch />, title: `Fetch « ${r.name} »`, onClick: () => void fetchRemoteAction(ui, snap, r.name) }, ...(add ? [add] : [])]}
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
  );
}
