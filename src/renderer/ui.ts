import { createContext, useContext } from 'react';
import type { DiffTarget } from '../shared/types';
import type { MenuItem } from './components/ContextMenu';
import type { PromptState } from './components/PromptDialog';

export interface Ui {
  /** Exécute une opération Git avec indicateur d'activité, gestion d'erreur et rafraîchissement. */
  run(label: string, fn: () => Promise<unknown>, success?: string): Promise<boolean>;
  openMenu(e: React.MouseEvent, items: MenuItem[]): void;
  ask(p: PromptState): void;
  showDiff(t: DiffTarget | null): void;
}

export const UiContext = createContext<Ui>(null as unknown as Ui);
export const useUi = () => useContext(UiContext);
