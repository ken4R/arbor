import type { RepoSnapshot } from '../../shared/types';
import { registerCommands, type CommandContext } from '../commands';
import { openRefActionDialog } from '../components/RefActionDialog';
import { dragDisabledReason } from '../refDrop';

// Commandes des branches : alternative au clavier du glisser-déposer (fusion, avance rapide, rebase, déplacement, push).

const GROUP = 'Branches';

type Ready = CommandContext & { snap: RepoSnapshot; ui: NonNullable<CommandContext['ui']> };
/** Dépôt chargé, non vide, et aucune opération Git en cours. */
const ready = (c: CommandContext): c is Ready => !!c.snap && !!c.ui && !c.busy && !dragDisabledReason(c.snap);

registerCommands('branches', () => [
  {
    id: 'branches.actions',
    title: 'Fusionner, rebaser ou pousser une branche…',
    group: GROUP,
    keywords: ['merge', 'rebase', 'push', 'fast-forward', 'avance rapide', 'déplacer', 'glisser'],
    enabled: ready,
    run: (c) => {
      if (!ready(c)) return;
      const current = c.snap.status.branch;
      openRefActionDialog(c.ui, c.snap, current ? { name: current, remote: false } : null);
    },
  },
]);
