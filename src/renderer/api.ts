import type { ArborApi, RepoChangeEvent, WatchLimitedEvent } from '../shared/types';

declare global {
  interface Window {
    arbor: {
      call(method: string, ...args: unknown[]): Promise<unknown>;
      on(event: 'repoChanged' | 'watchLimited', cb: (payload: unknown) => void): () => void;
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
