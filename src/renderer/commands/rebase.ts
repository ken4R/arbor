import type { RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { registerCommands, type CommandContext } from '../commands';
import { skipConfirmMessage } from '../components/OperationBanner';
import { openRebaseDialog } from '../components/RebaseDialog';

// Commandes du rebase interactif : ouvrir le planificateur (base demandée) et passer l'étape en cours.

type Ready = CommandContext & { snap: RepoSnapshot; ui: NonNullable<CommandContext['ui']> };
const ready = (c: CommandContext): c is Ready => !!c.snap && !!c.ui && !c.busy;

registerCommands('rebase', () => [
  {
    id: 'rebase.interactive',
    title: 'Rebase interactif…',
    group: 'Git',
    keywords: ['réécrire', 'squash', 'fixup', 'reword', 'réordonner', 'historique'],
    enabled: (c) => ready(c) && !!c.snap.head && c.snap.status.state === 'clean',
    run: (c) => {
      if (!ready(c)) return;
      const { ui, snap } = c;
      ui.ask({
        title: 'Rebase interactif',
        message: 'Les commits entre cette base et HEAD pourront être réordonnés, fusionnés, reformulés ou supprimés.',
        label: 'Base (branche, tag ou commit)',
        initial: snap.status.upstream ?? '',
        confirm: 'Continuer',
        onSubmit: (base) => openRebaseDialog(ui, snap, base, `« ${base} »`),
      });
    },
  },
  {
    id: 'rebase.skip',
    title: 'Passer l’étape en cours',
    group: 'Git',
    keywords: ['skip', 'rebase', 'cherry-pick', 'revert', 'ignorer'],
    enabled: (c) => ready(c) && ['rebasing', 'cherry-picking', 'reverting'].includes(c.snap.status.state),
    run: (c) => {
      if (!ready(c)) return;
      const { ui, snap } = c;
      ui.ask({
        title: 'Passer l’étape en cours',
        message: skipConfirmMessage(snap),
        confirm: 'Passer',
        danger: true,
        onSubmit: () => ui.run('Passage de l’étape…', () => api.skipOp(snap.path)),
      });
    },
  },
]);
