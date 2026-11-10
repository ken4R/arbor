import type { RepoSnapshot } from '../../shared/types';
import { openSubmoduleTab, resetSubmoduleAction, syncSubmodulesAction, initSubmodulesAction } from '../actions';
import { registerCommands, type Command, type CommandContext } from '../commands';
import { getSubmodules } from '../submodules';

// Commandes des sous-modules : mise à jour et synchronisation globales, puis une entrée par sous-module
// (liste du magasin `submodules.ts`, lue par la barre latérale à chaque instantané).

const GROUP = 'Sous-modules';

type Ready = CommandContext & { snap: RepoSnapshot; ui: NonNullable<CommandContext['ui']> };
/** Dépôt chargé, avec `.gitmodules`, et aucune opération Git en cours. */
const ready = (c: CommandContext): c is Ready => !!c.snap && !!c.ui && !c.busy && !!c.snap.features?.submodules;

registerCommands('submodules', (c) => {
  if (!c.snap?.features?.submodules) return [];
  const cmds: Command[] = [
    {
      id: 'submodules.initMissing',
      title: 'Initialiser les sous-modules manquants',
      group: GROUP,
      keywords: ['submodule', 'update', 'init', 'sous-module'],
      enabled: (x) => ready(x) && getSubmodules(x.snap.path).some((s) => s.state === 'uninitialized'),
      run: (x) => ready(x) && void initSubmodulesAction(x.ui, x.snap.path, null),
    },
    {
      id: 'submodules.sync',
      title: 'Synchroniser les URL des sous-modules',
      group: GROUP,
      keywords: ['submodule', 'sync', 'url', 'sous-module'],
      enabled: ready,
      run: (x) => ready(x) && void syncSubmodulesAction(x.ui, x.snap.path),
    },
  ];
  for (const s of getSubmodules(c.snap.path)) {
    const path = s.path;
    const current = (x: CommandContext) => (ready(x) ? getSubmodules(x.snap.path).find((o) => o.path === path) : undefined);
    if (s.initialized) {
      cmds.push({
        id: `submodules.open:${path}`,
        title: `Ouvrir le sous-module ${path}`,
        group: GROUP,
        keywords: ['submodule', 'onglet', 'sous-module'],
        enabled: (x) => !!current(x)?.initialized,
        run: (x) => ready(x) && void openSubmoduleTab(x.ui, x.snap.path, path),
      });
    } else if (s.state === 'uninitialized') {
      cmds.push({
        id: `submodules.init:${path}`,
        title: `Initialiser le sous-module ${path}`,
        group: GROUP,
        keywords: ['submodule', 'init', 'sous-module'],
        enabled: (x) => current(x)?.state === 'uninitialized',
        run: (x) => ready(x) && void initSubmodulesAction(x.ui, x.snap.path, path),
      });
    }
    if (s.state === 'changed' && s.expected) {
      cmds.push({
        id: `submodules.reset:${path}`,
        title: `Ramener le sous-module ${path} au commit attendu…`,
        group: GROUP,
        keywords: ['submodule', 'reset', 'checkout', 'sous-module'],
        enabled: (x) => current(x)?.state === 'changed',
        run: (x) => {
          const sub = current(x);
          if (ready(x) && sub) resetSubmoduleAction(x.ui, x.snap.path, path, sub.expected);
        },
      });
    }
  }
  return cmds;
});
