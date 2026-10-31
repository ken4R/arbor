import { useState } from 'react';
import type { DiffTarget, RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { useUi } from '../ui';
import { FileList } from './FileList';

const STATE_LABEL = {
  merging: 'Fusion en cours',
  rebasing: 'Rebase en cours',
  'cherry-picking': 'Cherry-pick en cours',
  reverting: 'Revert en cours',
} as const;

export function WorkingPanel({ repo, snap, activeDiff }: { repo: string; snap: RepoSnapshot; activeDiff: DiffTarget | null }) {
  const ui = useUi();
  const st = snap.status;
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [amend, setAmend] = useState(false);

  const all = (files: { path: string }[]) => files.map((f) => f.path);
  const canCommit = (st.staged.length > 0 || amend) && summary.trim().length > 0 && st.conflicted.length === 0;

  const doCommit = async () => {
    const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
    const ok = await ui.run('Commit…', () => api.commit(repo, message, amend));
    if (ok) {
      setSummary('');
      setDescription('');
      setAmend(false);
      ui.showDiff(null);
    }
  };

  const toggleAmend = (on: boolean) => {
    setAmend(on);
    const head = snap.commits.find((c) => c.sha === snap.head);
    if (on && head && !summary) {
      setSummary(head.subject);
      setDescription(head.body);
    }
  };

  return (
    <div className="panel working">
      {st.state !== 'clean' && (
        <div className="op-banner">
          <strong>{STATE_LABEL[st.state]}</strong>
          <span>{st.conflicted.length ? `${st.conflicted.length} conflit(s) à résoudre` : 'Plus de conflits : vous pouvez continuer.'}</span>
          <div className="op-actions">
            <button className="btn btn-sm" onClick={() => ui.run('Abandon…', () => api.abort(repo))}>
              Abandonner
            </button>
            <button className="btn btn-sm btn-primary" disabled={st.conflicted.length > 0} onClick={() => ui.run('Continuer…', () => api.continueOp(repo))}>
              Continuer
            </button>
          </div>
        </div>
      )}

      {st.conflicted.length > 0 && (
        <PanelSection title="Conflits" count={st.conflicted.length}>
          <FileList
            files={st.conflicted}
            activeDiff={activeDiff}
            diffFor={(f) => ({ kind: 'working', path: f.path, staged: false, conflict: true })}
            menu={(f) => [
              { label: 'Garder ma version (ours)', onClick: () => ui.run('Résolution…', () => api.resolve(repo, f.path, 'ours')) },
              { label: 'Garder leur version (theirs)', onClick: () => ui.run('Résolution…', () => api.resolve(repo, f.path, 'theirs')) },
              { label: 'Marquer comme résolu', onClick: () => ui.run('Indexation…', () => api.stage(repo, [f.path])) },
            ]}
            action={{ label: 'Résolu', onClick: (f) => ui.run('Indexation…', () => api.stage(repo, [f.path])) }}
          />
        </PanelSection>
      )}

      <PanelSection
        title="Non indexés"
        count={st.unstaged.length}
        action={st.unstaged.length ? { label: 'Tout indexer', onClick: () => ui.run('Indexation…', () => api.stage(repo, all(st.unstaged))) } : undefined}
      >
        <FileList
          files={st.unstaged}
          activeDiff={activeDiff}
          diffFor={(f) => ({ kind: 'working', path: f.path, staged: false, untracked: f.status === '?' })}
          action={{ label: 'Indexer', onClick: (f) => ui.run('Indexation…', () => api.stage(repo, [f.path])) }}
          menu={(f) => [
            { label: 'Indexer', onClick: () => ui.run('Indexation…', () => api.stage(repo, [f.path])) },
            'separator',
            {
              label: 'Annuler les modifications…',
              danger: true,
              onClick: () =>
                ui.ask({
                  title: 'Annuler les modifications',
                  message: `Les modifications de « ${f.path} » seront définitivement perdues.`,
                  confirm: 'Annuler les modifications',
                  danger: true,
                  onSubmit: () => ui.run('Annulation…', () => api.discard(repo, [f.path])),
                }),
            },
          ]}
        />
        {st.unstaged.length === 0 && <div className="empty">Rien à indexer</div>}
      </PanelSection>

      <PanelSection
        title="Indexés"
        count={st.staged.length}
        action={st.staged.length ? { label: 'Tout désindexer', onClick: () => ui.run('Désindexation…', () => api.unstage(repo, all(st.staged))) } : undefined}
      >
        <FileList
          files={st.staged}
          activeDiff={activeDiff}
          diffFor={(f) => ({ kind: 'working', path: f.path, staged: true })}
          action={{ label: 'Retirer', onClick: (f) => ui.run('Désindexation…', () => api.unstage(repo, [f.path])) }}
        />
        {st.staged.length === 0 && <div className="empty">Indexez des fichiers pour les commiter</div>}
      </PanelSection>

      <form
        className="commit-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (canCommit) void doCommit();
        }}
      >
        <input
          className="commit-summary"
          placeholder="Résumé du commit"
          value={summary}
          maxLength={200}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) void doCommit();
          }}
        />
        <textarea
          className="commit-desc"
          placeholder="Description (facultatif)"
          value={description}
          rows={4}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) void doCommit();
          }}
        />
        <div className="commit-row">
          <label className="check">
            <input type="checkbox" checked={amend} disabled={!snap.head} onChange={(e) => toggleAmend(e.target.checked)} />
            Modifier le dernier commit
          </label>
          <span className={`char-count${summary.length > 72 ? ' warn' : ''}`}>{summary.length}</span>
        </div>
        <button className="btn btn-primary btn-block" disabled={!canCommit}>
          {amend ? 'Modifier le commit' : st.staged.length ? `Commiter ${st.staged.length} fichier${st.staged.length > 1 ? 's' : ''}` : 'Commiter'}
        </button>
      </form>
    </div>
  );
}

export function PanelSection(props: { title: string; count: number; children: React.ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <section className="panel-section">
      <header className="panel-head">
        <span>
          {props.title} <span className="count">{props.count}</span>
        </span>
        {props.action && (
          <button className="link-btn" onClick={props.action.onClick}>
            {props.action.label}
          </button>
        )}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}
