import type { RepoSnapshot } from '../../shared/types';
import { registerCommands, type CommandContext } from '../commands';
import { canUndo, openReflogDialog, undoLastAction } from '../components/ReflogDialog';

// Commandes du reflog : annuler la dernière opération de la branche (comme le bouton Annuler) et ouvrir le reflog.
// Pas de raccourci clavier : Ctrl/Cmd+Z reste aux champs de texte.

type Ready = CommandContext & { snap: RepoSnapshot; ui: NonNullable<CommandContext['ui']> };
/** Dépôt chargé et aucune opération Git en cours. */
const ready = (c: CommandContext): c is Ready => !!c.snap && !!c.ui && !c.busy;

registerCommands('reflog', () => [
  {
    id: 'reflog.undo',
    title: 'Annuler la dernière opération',
    group: 'Git',
    keywords: ['undo', 'défaire', 'reflog', 'revenir', 'commit', 'amend', 'rebase', 'reset'],
    enabled: (c) => ready(c) && canUndo(c.snap),
    run: (c) => {
      if (ready(c) && canUndo(c.snap)) void undoLastAction(c.ui, c.snap);
    },
  },
  {
    id: 'reflog.show',
    title: 'Afficher le reflog…',
    group: 'Git',
    keywords: ['reflog', 'historique', 'récupérer', 'commits perdus', 'reset'],
    enabled: (c) => ready(c) && !!c.snap.head,
    run: (c) => {
      if (ready(c)) openReflogDialog(c.ui, c.snap);
    },
  },
]);
