import type { RepoSnapshot } from '../../../shared/types';
import { checkoutBranch } from '../../actions';
import { useUi } from '../../ui';
import { Icon } from '../Icons';
import { Section } from './Section';

/** Tags filtrés (plus récent d'abord), section repliée par défaut ; double-clic = checkout du tag. */
export function TagsSection({ snap, match }: { snap: RepoSnapshot; match: (s: string) => boolean }) {
  const ui = useUi();
  const repo = snap.path;
  const tags = snap.tags.filter((t) => match(t.name));

  return (
    <Section title="Tags" count={tags.length} icon={<Icon.tag />} collapsed>
      {tags.map((t) => (
        <div key={t.name} className="side-item" onDoubleClick={() => checkoutBranch(ui, repo, t.name)}>
          <span className="side-label">{t.name}</span>
        </div>
      ))}
    </Section>
  );
}
