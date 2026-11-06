import { activateTab, newTab, requestCloseTab, type TabsModel } from '../tabs';
import { formatShortcut } from '../commands';
import { Icon } from './Icons';

const repoName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Barre des onglets : un onglet par dépôt ouvert (ou écran d'accueil), bloquée pendant une opération. */
export function TabBar({ model, busy }: { model: TabsModel; busy: string | null }) {
  const locked = !!busy;
  const lockedTitle = busy ? `Opération en cours : ${busy}` : undefined;
  return (
    <div className="tabbar" role="tablist" aria-label="Dépôts ouverts">
      {model.tabs.map((t) => {
        const active = t.id === model.activeId;
        const name = t.repo ? repoName(t.repo) : 'Nouvel onglet';
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            className={`tab${active ? ' tab-active' : ''}${locked && !active ? ' tab-locked' : ''}`}
            title={lockedTitle ?? t.repo ?? 'Onglet vide'}
            onMouseDown={(e) => {
              // Clic du milieu : ferme l'onglet.
              if (e.button === 1) {
                e.preventDefault();
                requestCloseTab(t.id);
              }
            }}
            onClick={() => activateTab(t.id)}
          >
            <span className="tab-name">{name}</span>
            <button
              className="tab-close"
              title={`Fermer l'onglet (${formatShortcut('Mod+W')})`}
              aria-label={`Fermer ${name}`}
              disabled={locked}
              onClick={(e) => {
                e.stopPropagation();
                requestCloseTab(t.id);
              }}
            >
              <Icon.close />
            </button>
          </div>
        );
      })}
      <button className="tab-new" title={`Nouvel onglet (${formatShortcut('Mod+T')})`} aria-label="Nouvel onglet" disabled={locked} onClick={newTab}>
        +
      </button>
    </div>
  );
}
