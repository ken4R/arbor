import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** `hint` : précision affichée sous le libellé (raison d'une entrée grisée, par exemple). */
export type MenuItem = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string } | 'separator';

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** Touche qui ouvre un menu contextuel au clavier : touche Menu ou Maj+F10. */
export function isMenuKey(e: React.KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

/**
 * Menu contextuel. Au clavier : focus sur la première entrée active, ↑/↓ (et Début/Fin) pour se déplacer, Entrée
 * ou Espace pour choisir, Échap ou Tab pour fermer ; le focus revient ensuite à l'élément qui l'avait.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  // Garde le menu à l'intérieur de la fenêtre.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 8)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
  }, [menu]);

  // Focus sur la première entrée active ; rendu à l'élément précédent à la fermeture (s'il existe encore).
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus();
    return () => {
      if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) previous.focus();
    };
  }, [menu]);

  // Échap ferme le menu (le diff en dessous l'ignore tant qu'une surcouche est ouverte) ; flèches : entrée suivante.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity };
      if (!(e.key in moves)) return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? []);
      if (!items.length) return;
      e.preventDefault();
      e.stopPropagation();
      const step = moves[e.key];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = step === -Infinity ? 0 : step === Infinity ? items.length - 1 : i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length;
      items[next].focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="menu" role="menu" data-overlay ref={ref} style={pos} onClick={(e) => e.stopPropagation()}>
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            title={item.hint}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.label}
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
