import { useEffect, useState, useSyncExternalStore } from 'react';
import { DIFF_FONT_SIZE_MAX, DIFF_FONT_SIZE_MIN, MONO_FONT_MAX_LENGTH, type DiffMode, type ThemePreference } from '../../shared/prefs';
import { matchShortcut } from '../commands';
import { updatePreferences, usePreferences } from '../prefs';
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

// Caractères refusés par `normalizePreferences` (le nom finit dans une déclaration CSS).
const FORBIDDEN_FONT_CHARS = /[;{}<>\\]/;

export function PreferencesDialog() {
  const isOpen = useSyncExternalStore(subscribe, () => open);

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

  return isOpen ? <PreferencesForm /> : null;
}

function PreferencesForm() {
  const prefs = usePreferences();
  // Saisie libre de la police : enregistrée à chaque frappe si elle est acceptable.
  const [font, setFont] = useState(prefs.monoFont);
  const fontInvalid = FORBIDDEN_FONT_CHARS.test(font) || font.trim().length > MONO_FONT_MAX_LENGTH;
  const [size, setSize] = useState(String(prefs.diffFontSize));
  useEffect(() => setSize(String(prefs.diffFontSize)), [prefs.diffFontSize]);

  const changeFont = (v: string) => {
    setFont(v);
    if (!FORBIDDEN_FONT_CHARS.test(v) && v.trim().length <= MONO_FONT_MAX_LENGTH) void updatePreferences({ monoFont: v.trim() });
  };

  const changeSize = (v: string) => {
    setSize(v);
    const n = Number(v);
    if (v.trim() && Number.isFinite(n) && n >= DIFF_FONT_SIZE_MIN && n <= DIFF_FONT_SIZE_MAX) void updatePreferences({ diffFontSize: n });
  };

  const close = () => closePreferences();

  return (
    <div className="overlay" data-overlay onMouseDown={close}>
      <div
        className="dialog prefs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prefs-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          // Seul le dialogue se ferme (pas le diff ouvert dessous).
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          close();
        }}
      >
        <div className="prefs-head">
          <h2 id="prefs-title">Préférences</h2>
          <button className="icon-btn" title="Fermer (Échap)" onClick={close}>
            <Icon.close />
          </button>
        </div>

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
                  onClick={() => void updatePreferences({ theme: t.value })}
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
                  onClick={() => void updatePreferences({ diffMode: m.value })}
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
                className="prefs-size-input"
                min={DIFF_FONT_SIZE_MIN}
                max={DIFF_FONT_SIZE_MAX}
                value={size}
                onChange={(e) => changeSize(e.target.value)}
                onBlur={() => setSize(String(prefs.diffFontSize))}
              />
              <span className="prefs-unit">px</span>
            </span>
          </label>
          <label className="prefs-row prefs-row-col">
            <span className="prefs-label">Police du code</span>
            <input
              className={`prefs-font ${fontInvalid ? 'invalid' : ''}`}
              value={font}
              placeholder="Police à chasse fixe par défaut"
              spellCheck={false}
              onChange={(e) => changeFont(e.target.value)}
            />
            {fontInvalid ? (
              <span className="prefs-hint prefs-hint-error">Nom de police invalide (caractères ; {'{ } < > \\'} interdits).</span>
            ) : (
              <span className="prefs-hint">Ex. « Fira Code » ; laisser vide pour la police par défaut.</span>
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
            <input type="checkbox" checked={prefs.autoRefresh} onChange={(e) => void updatePreferences({ autoRefresh: e.target.checked })} />
            <span>
              Rafraîchissement automatique
              <span className="prefs-hint">Suivre les changements faits hors d'Arbor.</span>
            </span>
          </label>
          <label className="check prefs-check">
            <input type="checkbox" checked={prefs.restoreTabs} onChange={(e) => void updatePreferences({ restoreTabs: e.target.checked })} />
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
