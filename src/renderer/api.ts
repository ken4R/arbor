import type { ArborApi } from '../shared/types';

declare global {
  interface Window {
    arbor: { call(method: string, ...args: unknown[]): Promise<unknown> };
  }
}

/** Accès typé aux commandes Git exposées par le processus principal. */
export const api = new Proxy({} as ArborApi, {
  get: (_t, method: string) => (...args: unknown[]) => window.arbor.call(method, ...args),
});
