import { matchAccount } from '../../shared/accounts';
import { remoteOf } from '../../shared/remotes';
import { hostKey, isLoopbackHost, parseRemoteUrl } from '../../shared/remoteUrl';
import type { AccountInfo, Remote, RepoSnapshot } from '../../shared/types';
import { getAccounts } from '../accounts';
import { registerCommands, type Command } from '../commands';
import { openAccounts, type AccountsPrefill } from '../components/AccountsDialog';
import type { MenuItem } from '../components/ContextMenu';

// Commandes des comptes GitHub/GitLab (palette) et entrée du menu d'un remote.

const GROUP = 'Comptes';

/** URL d'un remote (fetch, sinon push). */
const urlOf = (r: Remote) => r.fetchUrl ?? r.pushUrl;

/**
 * Formulaire « Ajouter un compte » pré-rempli d'après l'URL d'un remote (pure) : github.com → GitHub, gitlab.com →
 * GitLab.com, autre hôte → GitLab auto-hébergé avec l'origine https (http seulement en boucle locale). null pour une
 * URL locale ou `git://`.
 */
export function prefillForRemoteUrl(url: string | null): AccountsPrefill | null {
  const loc = url ? parseRemoteUrl(url) : null;
  if (!loc || loc.protocol === 'git') return null;
  if (loc.host === 'github.com' || loc.host === 'ssh.github.com') return { choice: 'github' };
  if (loc.host === 'gitlab.com' || loc.host === 'altssh.gitlab.com') return { choice: 'gitlab-com' };
  // Le port SSH n'est pas celui de l'interface web : seul l'hôte est gardé.
  if (loc.protocol === 'ssh') return { choice: 'gitlab-self', instanceUrl: `https://${hostKey(loc.host, null)}` };
  if (loc.protocol === 'http' && isLoopbackHost(loc.host)) return { choice: 'gitlab-self', instanceUrl: `http://${hostKey(loc.host, loc.port)}` };
  return { choice: 'gitlab-self', instanceUrl: `https://${hostKey(loc.host, loc.protocol === 'https' ? loc.port : null)}` };
}

/** Hôte affiché d'un remote (`hôte[:port]`), ou null. */
export function remoteHost(url: string | null): string | null {
  const loc = url ? parseRemoteUrl(url) : null;
  if (!loc || loc.protocol === 'git') return null;
  return hostKey(loc.host, loc.protocol === 'ssh' ? null : loc.port);
}

/** Remote « courant » : celui de l'upstream de la branche courante, sinon `origin`, sinon le premier. */
export function currentRemote(snap: RepoSnapshot): Remote | null {
  const up = snap.status.upstream;
  const name = up ? remoteOf(snap.remotes, up) : null;
  return snap.remotes.find((r) => r.name === name) ?? snap.remotes.find((r) => r.name === 'origin') ?? snap.remotes[0] ?? null;
}

/**
 * Compte d'un remote hors composant React (palette, menu). Même règle que `useAccountForRemote` (vague 6 : choix
 * manuel du compte par dépôt, à faire au même endroit).
 */
function accountFor(remote: Remote, accounts: readonly AccountInfo[]): AccountInfo | null {
  const url = urlOf(remote);
  return url ? matchAccount(parseRemoteUrl(url), accounts) : null;
}

/** Commandes de la palette (pure, comptes donnés). */
export function buildAccountCommands(snap: RepoSnapshot | null, accounts: readonly AccountInfo[]): Command[] {
  const out: Command[] = [
    {
      id: 'accounts.open',
      title: 'Comptes…',
      group: GROUP,
      keywords: ['github', 'gitlab', 'jeton', 'token', 'connexion', 'compte', 'authentification'],
      run: () => openAccounts(),
    },
  ];
  const remote = snap ? currentRemote(snap) : null;
  const url = remote ? urlOf(remote) : null;
  const prefill = prefillForRemoteUrl(url);
  const host = remoteHost(url);
  if (remote && prefill && host && !accountFor(remote, accounts)) {
    out.push({
      id: 'accounts.connectForRemote',
      title: `Connecter un compte pour ${host}`,
      group: GROUP,
      keywords: ['github', 'gitlab', 'jeton', 'token', 'connexion', remote.name],
      run: () => openAccounts(prefill),
    });
  }
  return out;
}

registerCommands('accounts', (c) => buildAccountCommands(c.snap, getAccounts()));

/** Entrée du menu d'un remote : connecter un compte pour son hôte, ou ouvrir les comptes s'il en a déjà un. */
export function remoteAccountMenuItem(remote: Remote): MenuItem {
  const url = urlOf(remote);
  const prefill = prefillForRemoteUrl(url);
  const account = accountFor(remote, getAccounts());
  if (account) return { label: `Compte « ${account.login} »…`, onClick: () => openAccounts() };
  return { label: 'Connecter un compte pour cet hôte…', disabled: !prefill, onClick: () => prefill && openAccounts(prefill) };
}
