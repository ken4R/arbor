import type { RepoSnapshot } from '../../shared/types';
import { lfsFetchAction, lfsPullAction, lfsTrackAction, lfsUntrackAction } from '../actions';
import { registerCommands, type Command, type CommandContext } from '../commands';
import { getLfsInfo } from '../lfs';

// Commandes LFS : suivre un motif, télécharger, récupérer ; « Ne plus suivre » par motif du `.gitattributes` racine
// (informations du magasin `lfs.ts`, lues à chaque instantané d'un dépôt LFS).

const GROUP = 'LFS';

type Ready = CommandContext & { snap: RepoSnapshot; ui: NonNullable<CommandContext['ui']> };
/** Dépôt LFS chargé, git-lfs installé, aucune opération Git en cours. */
const ready = (c: CommandContext): c is Ready => !!c.snap && !!c.ui && !c.busy && !!c.snap.features?.lfs && !!getLfsInfo(c.snap.path)?.installed;

registerCommands('lfs', (c) => {
  if (!c.snap?.features?.lfs) return [];
  const cmds: Command[] = [
    {
      id: 'lfs.track',
      title: 'Suivre un motif LFS…',
      group: GROUP,
      keywords: ['lfs', 'track', 'gitattributes', 'binaire'],
      enabled: ready,
      run: (x) => ready(x) && lfsTrackAction(x.ui, x.snap.path),
    },
    {
      id: 'lfs.fetch',
      title: 'Télécharger les objets LFS (fetch)',
      group: GROUP,
      keywords: ['lfs', 'fetch', 'télécharger'],
      enabled: ready,
      run: (x) => ready(x) && void lfsFetchAction(x.ui, x.snap.path),
    },
    {
      id: 'lfs.pull',
      title: 'Récupérer les fichiers LFS (pull)',
      group: GROUP,
      keywords: ['lfs', 'pull', 'checkout', 'pointeur'],
      enabled: ready,
      run: (x) => ready(x) && void lfsPullAction(x.ui, x.snap.path, null),
    },
  ];
  for (const p of getLfsInfo(c.snap.path)?.patterns ?? []) {
    if (p.excluded || p.source !== '.gitattributes') continue;
    const pattern = p.pattern;
    cmds.push({
      id: `lfs.untrack:${pattern}`,
      title: `Ne plus suivre le motif LFS ${pattern}…`,
      group: GROUP,
      keywords: ['lfs', 'untrack'],
      enabled: ready,
      run: (x) => ready(x) && lfsUntrackAction(x.ui, x.snap.path, pattern),
    });
  }
  return cmds;
});
