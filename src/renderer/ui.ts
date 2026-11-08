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
  /**
   * Ouvre un dialogue spécifique (plusieurs champs) : `render(close)` est appelé une fois, son résultat est monté
   * au-dessus du dépôt jusqu'à `close()` (sans effet si un autre dialogue l'a remplacé entre-temps). Un nouvel appel
   * remplace le dialogue ouvert. Utiliser la coquille `components/Dialog.tsx` ; `ask` reste la voie pour une
   * confirmation ou un champ unique (et peut s'ouvrir par-dessus).
   * `render` n'est appelé qu'une fois : les props capturées (instantané, plan…) ne suivent pas les rafraîchissements.
   * Un dialogue qui dépend de l'état du dépôt le relit par `api.*` au moment d'agir, et le main revérifie.
   */
  openDialog(render: (close: () => void) => React.ReactNode): void;
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
