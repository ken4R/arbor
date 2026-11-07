import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatShortcut } from '../commands';
import { Icon, Logo } from './Icons';
import { openPreferences, PREFERENCES_SHORTCUT } from './PreferencesDialog';
import type { BusyOptions } from '../tabs';

export function Welcome({
  onOpen,
  initialError,
  onBusy,
}: {
  onOpen: (path: string) => void;
  initialError?: string | null;
  /** Ouverture, initialisation ou clonage en cours (bloque le changement d'onglet). */
  onBusy?: (label: string | null, opts?: BusyOptions) => void;
}) {
  const [recent, setRecent] = useState<string[]>([]);
  const [cloneUrl, setCloneUrl] = useState('');
  const [error, setError] = useState<string | null>(initialError ?? null);
  useEffect(() => setError(initialError ?? null), [initialError]);
  // Opération en cours : elle se termine par l'ouverture d'un dépôt, qui reste donc permise.
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => onBusy?.(busy, { allowOpen: true }), [busy, onBusy]);
  useEffect(() => () => onBusy?.(null), [onBusy]);

  useEffect(() => {
    api.recentRepos().then(setRecent).catch(() => {});
  }, []);

  const attempt = async (label: string, fn: () => Promise<string | null>) => {
    setError(null);
    setBusy(label);
    try {
      const p = await fn();
      if (p) onOpen(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-brand">
          <Logo size={44} />
          <div>
            <h1>Arbor</h1>
            <p>Un client Git visuel, clair et rapide.</p>
          </div>
        </div>

        <div className="welcome-actions">
          <button className="btn btn-primary" disabled={!!busy} onClick={() => attempt('Ouverture…', api.openRepoDialog)}>
            Ouvrir un dépôt…
          </button>
          <button className="btn" disabled={!!busy} onClick={() => attempt('Initialisation…', api.initRepoDialog)}>
            Initialiser un dépôt…
          </button>
        </div>

        <form
          className="clone-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (cloneUrl.trim()) attempt('Clonage…', () => api.cloneRepo(cloneUrl.trim()));
          }}
        >
          <input placeholder="https://github.com/utilisateur/projet.git" value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} spellCheck={false} />
          <button className="btn" disabled={!!busy || !cloneUrl.trim()}>
            {busy ?? 'Cloner'}
          </button>
        </form>

        {error && <div className="welcome-error">{error}</div>}

        {recent.length > 0 && (
          <div className="recent">
            <h3>Récents</h3>
            {recent.map((p) => (
              <button key={p} className="recent-item" onClick={() => onOpen(p)}>
                <span className="recent-name">{p.split(/[\\/]/).pop()}</span>
                <span className="recent-path">{p}</span>
              </button>
            ))}
          </div>
        )}
        <button className="link-btn welcome-prefs" onClick={openPreferences} title={`Préférences (${formatShortcut(PREFERENCES_SHORTCUT)})`}>
          <Icon.gear />
          Préférences
        </button>
      </div>
    </div>
  );
}
