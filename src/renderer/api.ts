import type { AccountsChangedEvent, ArborApi, CredentialDoneEvent, CredentialRequest, RepoChangeEvent, WatchLimitedEvent } from '../shared/types';

/** Événements poussés par le processus principal (liste blanche `EVENTS` du preload). */
export type ArborEvent = 'repoChanged' | 'watchLimited' | 'accountsChanged' | 'credentialRequest' | 'credentialDone';

declare global {
  interface Window {
    arbor: {
      call(method: string, ...args: unknown[]): Promise<unknown>;
      on(event: ArborEvent, cb: (payload: unknown) => void): () => void;
    };
  }
}

/** Accès typé aux commandes Git exposées par le processus principal. */
export const api = new Proxy({} as ArborApi, {
  get: (_t, method: string) => (...args: unknown[]) => window.arbor.call(method, ...args),
});

/** Prévient quand le dépôt surveillé (`api.watchRepo`) change hors d'Arbor ; renvoie le désabonnement. */
export function onRepoChanged(cb: (ev: RepoChangeEvent) => void): () => void {
  return window.arbor.on('repoChanged', (payload) => cb(payload as RepoChangeEvent));
}

/** Prévient (une fois par dépôt) que la surveillance a dû être réduite au dossier Git. */
export function onWatchLimited(cb: (ev: WatchLimitedEvent) => void): () => void {
  return window.arbor.on('watchLimited', (payload) => cb(payload as WatchLimitedEvent));
}

// comptes
/** Liste des comptes à jour après chaque ajout, suppression ou changement de statut (jamais de jeton). */
export function onAccountsChanged(cb: (ev: AccountsChangedEvent) => void): () => void {
  return window.arbor.on('accountsChanged', (payload) => cb(payload as AccountsChangedEvent));
}

// identifiants
/** Une commande Git demande des identifiants (dialogue global). */
export function onCredentialRequest(cb: (req: CredentialRequest) => void): () => void {
  return window.arbor.on('credentialRequest', (payload) => cb(payload as CredentialRequest));
}

/** Une demande est terminée (réponse, annulation ou fin de la commande) : son dialogue se ferme. */
export function onCredentialDone(cb: (ev: CredentialDoneEvent) => void): () => void {
  return window.arbor.on('credentialDone', (payload) => cb(payload as CredentialDoneEvent));
}
