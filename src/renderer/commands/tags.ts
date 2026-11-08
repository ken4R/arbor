import type { RepoSnapshot } from '../../shared/types';
import { registerCommands, type Command, type CommandContext } from '../commands';
import { openTagDialog, pushAllTagsAction } from '../components/TagDialog';

// Commandes des tags : création sur HEAD et publication de tous les tags (une entrée par remote).

const GROUP = 'Tags';

type Ready = CommandContext & { snap: RepoSnapshot; ui: NonNullable<CommandContext['ui']> };
/** Dépôt chargé et aucune opération Git en cours. */
const ready = (c: CommandContext): c is Ready => !!c.snap && !!c.ui && !c.busy;

registerCommands('tags', (c) => {
  const cmds: Command[] = [
    {
      id: 'tags.create',
      title: 'Créer un tag…',
      group: GROUP,
      keywords: ['nouveau', 'tag', 'étiquette', 'version'],
      enabled: (x) => ready(x) && !!x.snap.head,
      run: (x) => {
        if (!ready(x) || !x.snap.head) return;
        openTagDialog(x.ui, x.snap, x.snap.head, `HEAD (${x.snap.head.slice(0, 7)})`);
      },
    },
  ];
  for (const r of c.snap?.remotes ?? []) {
    cmds.push({
      id: `tags.pushAll:${r.name}`,
      title: `Pousser tous les tags vers ${r.name}`,
      group: GROUP,
      keywords: ['push', 'publier', 'tags'],
      enabled: (x) => ready(x) && x.snap.tags.length > 0 && x.snap.remotes.some((o) => o.name === r.name),
      run: (x) => ready(x) && void pushAllTagsAction(x.ui, x.snap.path, r.name),
    });
  }
  return cmds;
});
