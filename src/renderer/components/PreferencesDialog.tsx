import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DIFF_FONT_SIZE_MAX, DIFF_FONT_SIZE_MIN, normalizePreferences, type DiffMode, type Preferences, type ThemePreference } from '../../shared/prefs';
import { matchShortcut } from '../commands';
import { getPreferences, updatePreferences, usePreferences, usePreferencesLoaded } from '../prefs';
import { Icon } from './Icons';

// Dialogue des préférences : monté une fois hors de l'application (main.tsx), ouvert par `openPreferences()`,
// Ctrl/Cmd+, , le bouton engrenage de la barre d'outils, le lien de l'écran d'accueil ou la palette.
// Chaque champ est enregistré immédiatement (pas de bouton « Appliquer »).

export const PREFERENCES_SHORTCUT = 'Mod+,';

let open = false;
const listeners = new Set<() => void>();

function setOpen(v: boolean) {
  if (open === v) return;
  open = v;
  listeners.forEach((l) => l());
}

export function openPreferences(): void {
  setOpen(true);
}

export function closePreferences(): void {
  setOpen(false);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Système' },
  { value: 'light', label: 'Clair' },
  { value: 'dark', label: 'Sombre' },
];

const DIFF_MODES: { value: DiffMode; label: string }[] = [
  { value: 'unified', label: 'Unifié' },
  { value: 'split', label: 'Côte à côte' },
];

/** Nom de police accepté par `normalizePreferences` (liste blanche de caractères, longueur bornée). */
const fontAccepted = (v: string) => normalizePreferences({ monoFont: v }).monoFont === v.trim();

const sizeInRange = (n: number) => Number.isFinite(n) && n >= DIFF_FONT_SIZE_MIN && n <= DIFF_FONT_SIZE_MAX;

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function PreferencesDialog() {
  const isOpen = useSyncExternalStore(subscribe, () => open);
  // Formulaire rendu seulement une fois les préférences lues : sinon le champ police, initialisé avec la valeur
  // par défaut, écraserait la valeur enregistrée à la première frappe.
  const loaded = usePreferencesLoaded();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchShortcut(e, PREFERENCES_SHORTCUT)) return;
      e.preventDefault();
      if (open) closePreferences();
      // Pas par-dessus une autre surcouche (dialogue, palette) : elle garde le clavier.
      else if (!document.querySelector('[data-overlay]')) openPreferences();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return isOpen && loaded ? <PreferencesForm /> : null;
}

function PreferencesForm() {
  const prefs = usePreferences();
  // Saisie libre de la police : enregistrée à chaque frappe si elle est acceptable.
  const [font, setFont] = useState(prefs.monoFont);
  const fontInvalid = !fontAccepted(font);
  const [size, setSize] = useState(String(prefs.diffFontSize));
  useEffect(() => setSize(String(prefs.diffFontSize)), [prefs.diffFontSize]);
  const sizeInvalid = !size.trim() || !sizeInRange(Number(size));
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Élément qui avait le focus à l'ouverture (engrenage, lien…), lu au premier rendu, avant l'autoFocus.
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  /** Enregistre un champ ; en cas d'échec, `updatePreferences` remet la valeur enregistrée et on le signale. */
  const save = (patch: Partial<Preferences>) => {
    setError(null);
    updatePreferences(patch).catch((e: unknown) => {
      setError(`Préférence non enregistrée : ${e instanceof Error ? e.message : String(e)}`);
      if ('monoFont' in patch) setFont(getPreferences().monoFont);
    });
  };

  useEffect(() => {
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.focus();
    // Échap et piège Tab écoutés sur window (capture) : ils marchent même si le focus a quitté le dialogue.
    const onKey = (e: KeyboardEvent) => {
      if (!el) return;
      if (e.key === 'Escape') {
        // Seul le dialogue se ferme (pas le diff ouvert dessous).
        e.preventDefault();
        e.stopImmediatePropagation();
        closePreferences();
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
      // Focus rendu à l'élément d'origine à la fermeture.
      if (previous && previous.isConnected) previous.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const changeFont = (v: string) => {
    setFont(v);
    if (fontAccepted(v)) save({ monoFont: v.trim() });
  };

  const changeSize = (v: string) => {
    setSize(v);
    const n = Number(v);
    if (v.trim() && sizeInRange(n)) save({ diffFontSize: n });
  };

  const close = () => closePreferences();

  return (
    <div className="overlay" data-overlay onMouseDown={close}>
      <div
        ref={root}
        className="dialog prefs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prefs-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="prefs-head">
          <h2 id="prefs-title">Préférences</h2>
          <button className="icon-btn" title="Fermer (Échap)" onClick={close}>
            <Icon.close />
          </button>
        </div>

        {error && (
          <div className="prefs-error" role="alert">
            {error}
          </div>
        )}

        <section className="prefs-section">
          <h3>Apparence</h3>
          <div className="prefs-row">
            <span className="prefs-label">Thème</span>
            <div className="seg prefs-seg" role="radiogroup" aria-label="Thème">
              {THEMES.map((t, i) => (
                <button
                  key={t.value}
                  role="radio"
                  aria-checked={prefs.theme === t.value}
                  className={prefs.theme === t.value ? 'on' : ''}
                  autoFocus={prefs.theme === t.value || (i === 0 && !THEMES.some((x) => x.value === prefs.theme))}
                  onClick={() => save({ theme: t.value })}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="prefs-section">
          <h3>Diffs</h3>
          <div className="prefs-row">
            <span className="prefs-label">Affichage par défaut</span>
            <div className="seg prefs-seg" role="radiogroup" aria-label="Affichage par défaut des diffs">
              {DIFF_MODES.map((m) => (
                <button
                  key={m.value}
                  role="radio"
                  aria-checked={prefs.diffMode === m.value}
                  className={prefs.diffMode === m.value ? 'on' : ''}
                  onClick={() => save({ diffMode: m.value })}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <label className="prefs-row">
            <span className="prefs-label">Taille du code</span>
            <span className="prefs-size">
              <input
                type="range"
                className="prefs-range"
                min={DIFF_FONT_SIZE_MIN}
                max={DIFF_FONT_SIZE_MAX}
                step={1}
                value={prefs.diffFontSize}
                onChange={(e) => changeSize(e.target.value)}
                aria-label="Taille du code"
              />
              <input
                type="number"
                className={`prefs-size-input ${sizeInvalid ? 'invalid' : ''}`}
                aria-label="Taille du code en pixels"
                aria-invalid={sizeInvalid}
                min={DIFF_FONT_SIZE_MIN}
                max={DIFF_FONT_SIZE_MAX}
                step={1}
                value={size}
                onChange={(e) => changeSize(e.target.value)}
                onBlur={() => setSize(String(prefs.diffFontSize))}
              />
              <span className="prefs-unit">px</span>
            </span>
          </label>
          <label className="prefs-row prefs-row-col">
            <span className="prefs-label">Police à chasse fixe</span>
            <input
              className={`prefs-font ${fontInvalid ? 'invalid' : ''}`}
              value={font}
              placeholder="Police à chasse fixe par défaut"
              spellCheck={false}
              onChange={(e) => changeFont(e.target.value)}
            />
            {fontInvalid ? (
              <span className="prefs-hint prefs-hint-error">Nom de police invalide : lettres, chiffres, espaces et , ' " . _ - seulement.</span>
            ) : (
              <span className="prefs-hint">Tout le texte à chasse fixe (diffs, blame, identifiants…). Ex. « Fira Code » ; laisser vide pour la police par défaut.</span>
            )}
          </label>
          <div className="prefs-sample" aria-hidden="true">
            <span className="prefs-sample-del">- const branche = 'main';</span>
            <span className="prefs-sample-add">+ const branche = 'feature/login';</span>
          </div>
        </section>

        <section className="prefs-section">
          <h3>Comportement</h3>
          <label className="check prefs-check">
            <input type="checkbox" checked={prefs.autoRefresh} onChange={(e) => save({ autoRefresh: e.target.checked })} />
            <span>
              Rafraîchissement automatique
              <span className="prefs-hint">Suivre les changements faits hors d'Arbor.</span>
            </span>
          </label>
          <label className="check prefs-check">
            <input type="checkbox" checked={prefs.restoreTabs} onChange={(e) => save({ restoreTabs: e.target.checked })} />
            <span>
              Rouvrir les onglets au démarrage
              <span className="prefs-hint">Pris en compte au prochain lancement.</span>
            </span>
          </label>
        </section>
      </div>
    </div>
  );
}
