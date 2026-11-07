import type { RepoSnapshot } from '../../shared/types';
import { fetchRemoteAction, pruneRemoteAction } from '../actions';
import { registerCommands, type Command, type CommandContext } from '../commands';
import { openAddRemoteDialog } from '../components/RemoteDialog';

// Commandes de gestion des remotes : ajout, puis « Fetch <remote> » et « Prune <remote> » pour chaque remote.

const GROUP = 'Remotes';

type Ready = CommandContext & { snap: RepoSnapshot; ui: NonNullable<CommandContext['ui']> };
/** Dépôt chargé et aucune opération Git en cours. */
const ready = (c: CommandContext): c is Ready => !!c.snap && !!c.ui && !c.busy;

/** Commandes de la palette pour un instantané (fonction pure). */
export function buildRemoteCommands(snap: RepoSnapshot | null): Command[] {
  const out: Command[] = [
    {
      id: 'remotes.add',
      title: 'Ajouter un remote…',
      group: GROUP,
      keywords: ['distant', 'nouveau', 'url'],
      enabled: ready,
      run: (c) => ready(c) && openAddRemoteDialog(c.ui, c.snap),
    },
  ];
  for (const r of snap?.remotes ?? []) {
    out.push(
      {
        id: `remotes.fetch:${r.name}`,
        title: `Fetch ${r.name}`,
        group: GROUP,
        keywords: ['récupérer', 'distant', 'remote'],
        enabled: ready,
        run: (c) => ready(c) && void fetchRemoteAction(c.ui, c.snap, r.name),
      },
      {
        id: `remotes.prune:${r.name}`,
        title: `Prune ${r.name}`,
        group: GROUP,
        keywords: ['nettoyer', 'branches distantes', 'remote'],
        enabled: ready,
        run: (c) => ready(c) && void pruneRemoteAction(c.ui, c.snap, r.name),
      },
    );
  }
  return out;
}

registerCommands('remotes', (c) => buildRemoteCommands(c.snap));
