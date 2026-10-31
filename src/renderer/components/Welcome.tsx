import { useEffect, useState } from 'react';
import { api } from '../api';
import { Logo } from './Icons';

export function Welcome({ onOpen }: { onOpen: (path: string) => void }) {
  const [recent, setRecent] = useState<string[]>([]);
  const [cloneUrl, setCloneUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.recentRepos().then(setRecent).catch(() => {});
  }, []);

  const attempt = async (fn: () => Promise<string | null>) => {
    setError(null);
    setBusy(true);
    try {
      const p = await fn();
      if (p) onOpen(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
          <button className="btn btn-primary" disabled={busy} onClick={() => attempt(api.openRepoDialog)}>
            Ouvrir un dépôt…
          </button>
          <button className="btn" disabled={busy} onClick={() => attempt(api.initRepoDialog)}>
            Initialiser un dépôt…
          </button>
        </div>

        <form
          className="clone-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (cloneUrl.trim()) attempt(() => api.cloneRepo(cloneUrl.trim()));
          }}
        >
          <input placeholder="https://github.com/utilisateur/projet.git" value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} spellCheck={false} />
          <button className="btn" disabled={busy || !cloneUrl.trim()}>
            {busy ? 'En cours…' : 'Cloner'}
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
      </div>
    </div>
  );
}
