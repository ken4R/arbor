// Contexte d'opération : chaque handler IPC s'exécute dans `withOperation`, ce qui permet au crochet
// d'authentification de `git.ts` de savoir quelle opération (et quel dépôt) a lancé une commande réseau, sans
// ajouter de paramètre aux fonctions de `git.ts`.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface OperationContext {
  /** Nom du handler IPC (« fetch », « cloneRepo »…). */
  operation: string;
  /** Dépôt concerné ; null pour les handlers sans dépôt (`NO_REPO`). */
  repo: string | null;
}

const storage = new AsyncLocalStorage<OperationContext>();

export function withOperation<T>(ctx: OperationContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Opération en cours, ou null hors d'un handler IPC. */
export function currentOperation(): OperationContext | null {
  return storage.getStore() ?? null;
}
