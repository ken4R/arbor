import { matchShortcut, registerCommands, runCommand, type Command } from '../commands';

// Commandes de l'éditeur de fusion (palette et raccourcis Alt+…), disponibles seulement quand il est ouvert :
// `MergeEditor` publie son interface par `setActiveMergeEditor` à l'ouverture et la retire à la fermeture.

export interface MergeEditorHandle {
  /** Le fichier a au moins un conflit de contenu. */
  readonly hasConflicts: boolean;
  /** Le bloc courant est un conflit (les choix Alt+1/2/3 s'y appliquent). */
  readonly onConflict: boolean;
  /** Plus aucun conflit non résolu : « Enregistrer et marquer résolu » est possible. */
  readonly canMark: boolean;
  next(): void;
  previous(): void;
  choose(c: 'mine' | 'theirs' | 'mine-theirs'): void;
  save(mark: boolean): void;
}

let active: MergeEditorHandle | null = null;

export function setActiveMergeEditor(h: MergeEditorHandle | null): void {
  active = h;
}

const SHORTCUTS = { next: 'Alt+ArrowDown', previous: 'Alt+ArrowUp', mine: 'Alt+1', theirs: 'Alt+2', both: 'Alt+3' } as const;
const GROUP = 'Conflits';

registerCommands('conflicts', (c) => {
  const h = active;
  if (!h) return [];
  const idle = () => !c.busy;
  const choose = (choice: 'mine' | 'theirs' | 'mine-theirs') => () => h.choose(choice);
  const cmds: Command[] = [
    { id: 'conflicts.next', title: 'Conflit suivant', group: GROUP, shortcut: SHORTCUTS.next, enabled: () => h.hasConflicts, run: () => h.next() },
    { id: 'conflicts.previous', title: 'Conflit précédent', group: GROUP, shortcut: SHORTCUTS.previous, enabled: () => h.hasConflicts, run: () => h.previous() },
    // Hors d'un conflit, Alt+1/2/3 amène au prochain conflit sans rien choisir.
    { id: 'conflicts.mine', title: 'Garder ma version (conflit courant)', group: GROUP, keywords: ['ours'], shortcut: SHORTCUTS.mine, enabled: () => h.hasConflicts, run: choose('mine') },
    { id: 'conflicts.theirs', title: 'Garder leur version (conflit courant)', group: GROUP, keywords: ['theirs'], shortcut: SHORTCUTS.theirs, enabled: () => h.hasConflicts, run: choose('theirs') },
    { id: 'conflicts.both', title: 'Garder les deux versions (conflit courant)', group: GROUP, shortcut: SHORTCUTS.both, enabled: () => h.hasConflicts, run: choose('mine-theirs') },
    { id: 'conflicts.save', title: 'Enregistrer la fusion', group: GROUP, keywords: ['sauvegarder'], enabled: idle, run: () => h.save(false) },
    {
      id: 'conflicts.saveResolved',
      title: 'Enregistrer et marquer résolu',
      group: GROUP,
      keywords: ['résoudre', 'indexer'],
      enabled: () => idle() && h.canMark,
      run: () => h.save(true),
    },
  ];
  return cmds;
});

/** Raccourcis de l'éditeur de fusion (fenêtre entière) ; ignorés sans éditeur ouvert ou sous une surcouche. */
export function onConflictShortcut(e: KeyboardEvent) {
  if (!active || document.querySelector('[data-overlay]')) return;
  const name = (Object.keys(SHORTCUTS) as (keyof typeof SHORTCUTS)[]).find((k) => matchShortcut(e, SHORTCUTS[k]));
  if (!name) return;
  e.preventDefault();
  e.stopPropagation();
  runCommand(`conflicts.${name}`);
}

window.addEventListener('keydown', onConflictShortcut);
