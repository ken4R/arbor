import { createContext, useContext } from 'react';
import type { DiffTarget } from '../shared/types';
import type { MenuItem } from './components/ContextMenu';
import type { PromptState } from './components/PromptDialog';

export interface Ui {
  /**
   * Exécute une opération Git avec indicateur d'activité, gestion d'erreur et rafraîchissement.
   * `opts.allowOpen` : l'opération se termine par l'ouverture d'un dépôt, permise malgré l'opération en cours.
   */
  run(label: string, fn: () => Promise<unknown>, success?: string, opts?: RunOptions): Promise<boolean>;
  openMenu(e: React.MouseEvent, items: MenuItem[]): void;
  ask(p: PromptState): void;
  showDiff(t: DiffTarget | null): void;
  /** Ouvre l'historique ou le blame d'un fichier (ferme le diff affiché). */
  showFile(v: FileViewTarget | null): void;
}

export interface RunOptions {
  allowOpen?: boolean;
}

/** Fichier affiché dans la vue Historique / Blame. */
export interface FileViewTarget {
  path: string;
  /** Révision de départ de l'historique et du blame ; null = HEAD (blame : arbre de travail). */
  rev: string | null;
  /** Révision du blame si elle diffère de `rev` (fichier supprimé : blame sur le parent). */
  blameRev?: string | null;
  tab: 'history' | 'blame';
}

export const UiContext = createContext<Ui>(null as unknown as Ui);
export const useUi = () => useContext(UiContext);
