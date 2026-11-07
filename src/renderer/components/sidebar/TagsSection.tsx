import type { RepoSnapshot, Tag } from '../../../shared/types';
import { checkoutTag, tagMenu } from '../../actions';
import { useUi } from '../../ui';
import { Icon, IconTagAdd } from '../Icons';
import { openTagDialog } from '../TagDialog';
import { Section } from './Section';

/** Nombre maximal de tags affichés : au-delà, le filtre de la barre latérale permet de les trouver. */
const MAX_TAGS = 300;

/** Infobulle : sujet du tag annoté, ou ce qui empêche de sélectionner son commit. */
function tagTitle(t: Tag, loaded: boolean): string {
  const lines = [t.annotated ? `Tag annoté ${t.name}` : `Tag léger ${t.name}`];
  if (t.subject) lines.push(t.subject);
  if (t.sha === null) lines.push("Ne pointe pas vers un commit");
  else if (!loaded) lines.push(`Commit ${t.sha.slice(0, 7)} hors du graphe chargé`);
  else lines.push(`Commit ${t.sha.slice(0, 7)}`);
  return lines.join('\n');
}

/**
 * Tags filtrés (plus récent d'abord), section repliée par défaut. Clic : sélectionne le commit s'il est chargé dans
 * le graphe ; double-clic : checkout de `refs/tags/<nom>` (rien si le tag ne pointe pas vers un commit).
 */
export function TagsSection({ snap, match, onSelectCommit }: { snap: RepoSnapshot; match: (s: string) => boolean; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const repo = snap.path;
  const tags = snap.tags.filter((t) => match(t.name));
  const shown = tags.slice(0, MAX_TAGS);
  const loaded = new Set(snap.commits.map((c) => c.sha));
  const head = snap.head;
  const actions = head
    ? [{ icon: <IconTagAdd />, title: 'Nouveau tag sur HEAD', onClick: () => openTagDialog(ui, snap, head, `HEAD (${head.slice(0, 7)})`) }]
    : [];

  return (
    <Section title="Tags" count={tags.length} icon={<Icon.tag />} collapsed actions={actions}>
      {shown.map((t) => {
        const inGraph = t.sha !== null && loaded.has(t.sha);
        return (
          <div
            key={t.name}
            className={`side-item${inGraph ? '' : ' side-item-off'}`}
            title={tagTitle(t, inGraph)}
            onClick={() => inGraph && onSelectCommit(t.sha!)}
            onDoubleClick={() => t.sha !== null && void checkoutTag(ui, repo, t)}
            onContextMenu={(e) => ui.openMenu(e, tagMenu(ui, snap, t))}
          >
            <span className="side-label">{t.name}</span>
            {t.annotated && <span className="tag-annotated" aria-label="annoté">◆</span>}
          </div>
        );
      })}
      {tags.length > MAX_TAGS && <div className="side-empty">Filtrez pour voir les {tags.length - MAX_TAGS} autres</div>}
      {snap.tags.length === 0 && <div className="side-empty">Aucun tag</div>}
    </Section>
  );
}
