import { matchShortcut, registerCommands, runCommand, type Command } from '../commands';
import { canReopenClosed, requestCloseTab, cycleTabs, getTabsBusy, getTabsModel, newTab, reopenClosedTab } from '../tabs';

// Commandes des onglets. Changer ou fermer d'onglet est indisponible pendant une opération.

const idle = () => !getTabsBusy();

/** Raccourcis réservés aux onglets. */
const SHORTCUTS = { new: 'Mod+T', close: 'Mod+W', next: 'Ctrl+Tab', previous: 'Ctrl+Shift+Tab' } as const;

registerCommands('tabs', () => {
  const model = getTabsModel();
  const many = model.tabs.length > 1;
  const cmds: Command[] = [
    { id: 'tabs.new', title: 'Nouvel onglet', group: 'Onglets', keywords: ['tab', 'ouvrir'], shortcut: SHORTCUTS.new, enabled: idle, run: () => newTab() },
    {
      id: 'tabs.close',
      title: "Fermer l'onglet",
      group: 'Onglets',
      keywords: ['tab'],
      shortcut: SHORTCUTS.close,
      // Le seul onglet, s'il est vide, n'a rien à fermer.
      enabled: () => idle() && (many || model.tabs[0]?.repo != null),
      run: () => requestCloseTab(),
    },
    { id: 'tabs.next', title: 'Onglet suivant', group: 'Onglets', keywords: ['tab'], shortcut: SHORTCUTS.next, enabled: () => idle() && many, run: () => cycleTabs(1) },
    {
      id: 'tabs.previous',
      title: 'Onglet précédent',
      group: 'Onglets',
      keywords: ['tab'],
      shortcut: SHORTCUTS.previous,
      enabled: () => idle() && many,
      run: () => cycleTabs(-1),
    },
    {
      id: 'tabs.reopen',
      title: "Rouvrir l'onglet fermé",
      group: 'Onglets',
      keywords: ['tab', 'annuler'],
      enabled: () => idle() && canReopenClosed(),
      run: () => reopenClosedTab(),
    },
  ];
  return cmds;
});

/**
 * Raccourcis clavier des onglets, à l'écoute sur la fenêtre. Ignorés quand une surcouche (`[data-overlay]` :
 * dialogue, menu, palette…) est ouverte. La touche est toujours consommée, même si la commande est indisponible
 * (Ctrl+Tab ne doit pas déplacer le focus, Ctrl+W ne doit rien fermer d'autre).
 */
export function onTabShortcut(e: KeyboardEvent) {
  if (document.querySelector('[data-overlay]')) return;
  const name = (Object.keys(SHORTCUTS) as (keyof typeof SHORTCUTS)[]).find((k) => matchShortcut(e, SHORTCUTS[k]));
  if (!name) return;
  e.preventDefault();
  e.stopPropagation();
  runCommand(`tabs.${name}`);
}

window.addEventListener('keydown', onTabShortcut);
