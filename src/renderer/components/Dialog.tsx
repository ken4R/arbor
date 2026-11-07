import { useEffect, useId, useRef, useState } from 'react';

// Coquille des dialogues spécifiques ouverts par `ui.openDialog((close) => <MonDialogue onClose={close} …/>)`.
// Reprend les classes de `PromptDialog` (`.overlay`, `.dialog`, `.dialog-msg`, `.field`, `.check`, `.dialog-actions`).
// Porte `data-overlay` : Échap ne ferme ni le diff ni la vue fichier tant qu'elle est ouverte.

export interface DialogProps {
  title: React.ReactNode;
  /** Appelé par Échap, un clic hors du dialogue et le bouton Annuler (peut demander confirmation avant de fermer). */
  onClose: () => void;
  /** Bouton principal et Entrée dans un champ ; absent = pas de bouton principal (seulement Annuler/Fermer). */
  onSubmit?: () => void;
  submitLabel?: string; // défaut « Valider »
  submitDisabled?: boolean;
  /** Bouton principal en rouge (action destructrice). */
  danger?: boolean;
  cancelLabel?: string; // défaut « Annuler » (« Fermer » sans `onSubmit`)
  /** Remplace toute la zone d'actions par défaut (Annuler + bouton principal). */
  actions?: React.ReactNode;
  /** Message sous le titre (classe `.dialog-msg`). */
  message?: React.ReactNode;
  /** Classe ajoutée à `.dialog` (largeur, mise en page propre au dialogue). */
  className?: string;
  children?: React.ReactNode;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Dialog(props: DialogProps) {
  const root = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const titleId = useId();
  // Toujours la dernière version des props dans les écouteurs installés une seule fois.
  const latest = useRef(props);
  latest.current = props;
  // Élément qui avait le focus à l'ouverture, lu au premier rendu (avant un éventuel autoFocus).
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    const el = form.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    // Échap et piège Tab sur window (capture), seulement si ce dialogue est la surcouche du dessus : une confirmation
    // `ui.ask` ou un menu ouvert par-dessus garde le clavier.
    const onKey = (e: KeyboardEvent) => {
      const overlays = document.querySelectorAll('[data-overlay]');
      if (!el || !root.current || overlays[overlays.length - 1] !== root.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        latest.current.onClose();
      } else if (e.key === 'Tab') {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const inside = el.contains(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === el)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (previous && previous.isConnected) previous.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (props.onSubmit && !props.submitDisabled) props.onSubmit();
  };

  return (
    <div className="overlay" data-overlay ref={root} onMouseDown={props.onClose}>
      <form
        ref={form}
        className={`dialog${props.className ? ` ${props.className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId}>{props.title}</h2>
        {props.message && <p className="dialog-msg">{props.message}</p>}
        {props.children}
        <div className="dialog-actions">
          {props.actions ?? (
            <>
              <button type="button" className="btn" onClick={props.onClose}>
                {props.cancelLabel ?? (props.onSubmit ? 'Annuler' : 'Fermer')}
              </button>
              {props.onSubmit && (
                <button type="submit" className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'}`} disabled={props.submitDisabled}>
                  {props.submitLabel ?? 'Valider'}
                </button>
              )}
            </>
          )}
        </div>
      </form>
    </div>
  );
}
