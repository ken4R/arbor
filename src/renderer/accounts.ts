import { useMemo, useSyncExternalStore } from 'react';
import { matchAccount } from '../shared/accounts';
import { parseRemoteUrl } from '../shared/remoteUrl';
import type { AccountInfo, AccountStorageStatus, Remote } from '../shared/types';
import { api, onAccountsChanged } from './api';

// Comptes connectés côté rendu : copie de la liste tenue par le processus principal (`listAccounts`, puis
// l'événement `accountsChanged`). Jamais de jeton ici : `AccountInfo` n'en contient pas.

let accounts: AccountInfo[] = [];
let storage: AccountStorageStatus | null = null;
let started = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Charge la liste et s'abonne aux changements, une seule fois (au premier usage). */
function start() {
  if (started) return;
  started = true;
  onAccountsChanged((ev) => {
    accounts = Array.isArray(ev?.accounts) ? ev.accounts : [];
    emit();
    // L'état du trousseau peut avoir changé (chiffrement en échec, compte gardé en mémoire) : relu à chaque fois.
    api.accountStorage().then(
      (s) => {
        storage = s;
        emit();
      },
      () => {},
    );
  });
  void refreshAccounts();
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Relit la liste des comptes et l'état du chiffrement (après une erreur, à l'ouverture du dialogue des comptes…). */
export async function refreshAccounts(): Promise<void> {
  try {
    const [list, status] = await Promise.all([api.listAccounts(), api.accountStorage()]);
    accounts = list;
    storage = status;
    emit();
  } catch {
    // processus principal pas encore prêt : la liste arrivera par `accountsChanged`
  }
}

export function getAccounts(): AccountInfo[] {
  start();
  return accounts;
}

/** Comptes connectés (liste vide tant qu'elle n'est pas chargée). */
export function useAccounts(): AccountInfo[] {
  return useSyncExternalStore(subscribe, () => accounts);
}

/** Disponibilité du chiffrement des jetons ; null tant qu'elle n'est pas connue. */
export function useAccountStorage(): AccountStorageStatus | null {
  return useSyncExternalStore(subscribe, () => storage);
}

/**
 * Compte associé à un remote (URL de fetch, sinon de push) ; null s'il n'y en a pas. Seul point d'usage de
 * `matchAccount` dans le rendu (vague 6 : choix manuel du compte par dépôt).
 */
export function useAccountForRemote(remote: Remote | null): AccountInfo | null {
  const list = useAccounts();
  const url = remote ? (remote.fetchUrl ?? remote.pushUrl) : null;
  return useMemo(() => (url ? matchAccount(parseRemoteUrl(url), list) : null), [url, list]);
}
