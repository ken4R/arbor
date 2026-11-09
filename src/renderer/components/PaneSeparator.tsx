import { useRef, useState } from 'react';
import { clampWidth } from '../../shared/prefs';

/** Pas d'un séparateur au clavier (←/→), en pixels. */
export const SEPARATOR_STEP = 16;

interface Props {
  /** Panneau redimensionné : la barre latérale (à gauche du séparateur) ou le panneau de droite (à sa droite). */
  side: 'left' | 'right';
  label: string;
  /** Variable CSS de `.main` qui porte la largeur (`--sidebar-w`, `--right-w`). */
  cssVar: string;
  value: number;
  min: number;
  max: number;
  /** Largeur par défaut (double-clic). */
  byDefault: number;
  /** Élément `.main` : la largeur y est appliquée directement pendant le glissement, sans rendu de la vue. */
  container: React.RefObject<HTMLElement | null>;
  /** Largeur finale, au relâchement de la souris ou de la touche. */
  onCommit: (width: number) => void;
}

/** Séparateur vertical redimensionnable à la souris et au clavier (`role="separator"`, ←/→, Origine/Fin). */
export function PaneSeparator({ side, label, cssVar, value, min, max, byDefault, container, onCommit }: Props) {
  // Largeur affichée pendant un glissement ou une suite de touches ; `null` = valeur enregistrée.
  // Doublée d'une référence : plusieurs événements peuvent arriver avant le rendu suivant.
  const [live, setLiveState] = useState<number | null>(null);
  const liveRef = useRef<number | null>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const width = live ?? value;
  const clamp = (w: number) => clampWidth(w, min, max, value);
  const setLive = (w: number | null) => {
    liveRef.current = w;
    setLiveState(w);
  };

  const apply = (w: number) => {
    setLive(w);
    container.current?.style.setProperty(cssVar, `${w}px`);
  };
  const commit = (w: number) => {
    setLive(null);
    container.current?.style.setProperty(cssVar, `${w}px`);
    if (w !== value) onCommit(w);
  };
  const commitLive = () => {
    if (liveRef.current !== null && !drag.current) commit(liveRef.current);
  };

  return (
    <div
      className={`pane-sep pane-sep-${side}${live !== null ? ' active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} (glisser, ←/→, double-clic : largeur par défaut)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus();
        drag.current = { x: e.clientX, start: liveRef.current ?? value };
        setLive(drag.current.start);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        apply(clamp(side === 'left' ? d.start + dx : d.start - dx));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        commitLive();
      }}
      onPointerCancel={() => {
        drag.current = null;
        commit(value);
      }}
      onDoubleClick={() => commit(byDefault)}
      onKeyDown={(e) => {
        // ← rétrécit la barre latérale mais élargit le panneau de droite (le séparateur suit la flèche).
        const grow = side === 'left' ? 1 : -1;
        let next: number | null = null;
        const cur = liveRef.current ?? value;
        if (e.key === 'ArrowLeft') next = cur - grow * SEPARATOR_STEP;
        else if (e.key === 'ArrowRight') next = cur + grow * SEPARATOR_STEP;
        else if (e.key === 'Home') next = min;
        else if (e.key === 'End') next = max;
        if (next === null) return;
        e.preventDefault();
        apply(clamp(next));
      }}
      onKeyUp={commitLive}
      onBlur={commitLive}
    />
  );
}
