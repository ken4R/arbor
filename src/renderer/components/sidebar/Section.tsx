import { useState } from 'react';
import { Icon } from '../Icons';

/** Bouton d'action affiché à droite de l'en-tête d'une section (ex. « + » pour ajouter). */
export interface SectionAction {
  icon: React.ReactNode;
  title: string; // infobulle et libellé accessible
  onClick: () => void;
}

export interface SectionProps {
  /** Identifiant stable de la section (local, remote:<nom>, remotes, tags, stashes, submodules, lfs) ; inutilisé pour l'instant. */
  id?: string;
  title: string;
  count: number;
  icon: React.ReactNode;
  children: React.ReactNode;
  /** Section repliée au premier affichage. */
  collapsed?: boolean;
  actions?: SectionAction[];
  /** Menu contextuel de l'en-tête (ex. menu du remote). */
  onContextMenu?: (e: React.MouseEvent) => void;
}

/** Section repliable de la barre latérale : en-tête (chevron, icône, titre, compteur, actions) puis contenu. */
export function Section(props: SectionProps) {
  const [open, setOpen] = useState(!props.collapsed);
  const hasActions = !!props.actions?.length;
  const head = (
    <button className={`side-head${open ? ' open' : ''}`} onClick={() => setOpen(!open)} onContextMenu={hasActions ? undefined : props.onContextMenu}>
      <Icon.chevron />
      {props.icon}
      <span className="side-title">{props.title}</span>
      <span className="side-count">{props.count}</span>
    </button>
  );
  return (
    <section className="side-section">
      {hasActions ? (
        // Les actions sont des boutons frères de l'en-tête (un bouton ne peut pas en contenir un autre).
        <div className="side-head-row" onContextMenu={props.onContextMenu}>
          {head}
          {props.actions!.map((a) => (
            <button key={a.title} className="side-head-action" title={a.title} aria-label={a.title} onClick={a.onClick}>
              {a.icon}
            </button>
          ))}
        </div>
      ) : (
        head
      )}
      {open && <div className="side-body">{props.children}</div>}
    </section>
  );
}
