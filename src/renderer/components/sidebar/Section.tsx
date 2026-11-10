import { createContext, useContext, useState } from 'react';
import { Icon } from '../Icons';

/** Bouton d'action affiché à droite de l'en-tête d'une section (ex. « + » pour ajouter). */
export interface SectionAction {
  icon: React.ReactNode;
  title: string; // infobulle et libellé accessible
  onClick: () => void;
}

/**
 * État replié des sections de l'onglet, fourni par `Sidebar` : une section avec `id` en dépend (il survit au
 * changement d'onglet et au redémarrage). `collapsed` ne contient que les sections dont l'état diffère du défaut.
 */
export interface SectionState {
  collapsed: Record<string, boolean>;
  setCollapsed: (id: string, collapsed: boolean, byDefault: boolean) => void;
}

export const SectionStateContext = createContext<SectionState | null>(null);

export interface SectionProps {
  /** Identifiant stable de la section (local, remote:<nom>, remotes, tags, stashes, submodules, lfs) : clé de son état replié. */
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
  const ctx = useContext(SectionStateContext);
  const [localOpen, setLocalOpen] = useState(!props.collapsed);
  const byDefault = !!props.collapsed;
  // Avec un `id` et un contexte : état de l'onglet ; sinon état local, perdu au démontage.
  const controlled = !!ctx && props.id !== undefined;
  const open = controlled ? !(ctx.collapsed[props.id!] ?? byDefault) : localOpen;
  const setOpen = (next: boolean) => (controlled ? ctx.setCollapsed(props.id!, !next, byDefault) : setLocalOpen(next));
  const hasActions = !!props.actions?.length;
  const head = (
    <button className={`side-head${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} onContextMenu={hasActions ? undefined : props.onContextMenu}>
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
