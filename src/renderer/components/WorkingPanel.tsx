import type { DiffTarget, RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { useUi } from '../ui';
import { FileList } from './FileList';
import { fileViewItems } from './FileView';
import { OperationBanner } from './OperationBanner';

/** Message de commit en cours, conservé par App quand on consulte un autre commit. */
export interface CommitDraft {
  summary: string;
  description: string;
  amend: boolean;
}

export const EMPTY_DRAFT: CommitDraft = { summary: '', description: '', amend: false };

interface Props {
  repo: string;
  snap: RepoSnapshot;
  activeDiff: DiffTarget | null;
  draft: CommitDraft;
  onDraft: (d: CommitDraft) => void;
}

export function WorkingPanel({ repo, snap, activeDiff, draft, onDraft }: Props) {
  const ui = useUi();
  const st = snap.status;
  const { summary, description, amend } = draft;
  const setSummary = (v: string) => onDraft({ ...draft, summary: v });
  const setDescription = (v: string) => onDraft({ ...draft, description: v });

  const all = (files: { path: string }[]) => files.map((f) => f.path);
  // Désindexer un renommage doit aussi désindexer la suppression de l'ancien chemin.
  const withOld = (files: { path: string; oldPath?: string }[]) => files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
  const canCommit = (st.staged.length > 0 || amend) && summary.trim().length > 0 && st.conflicted.length === 0;

  const doCommit = async () => {
    const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
    const ok = await ui.run('Commit…', () => api.commit(repo, message, amend));
    if (ok) {
      onDraft(EMPTY_DRAFT);
      ui.showDiff(null);
    }
  };

  const toggleAmend = (on: boolean) => {
    const head = snap.commits.find((c) => c.sha === snap.head);
    if (on && head && !summary) onDraft({ summary: head.subject, description: head.body, amend: true });
    else onDraft({ ...draft, amend: on });
  };

  return (
    <div className="panel working">
      <OperationBanner repo={repo} snap={snap} />

      {st.conflicted.length > 0 && (
        <PanelSection title="Conflits" count={st.conflicted.length}>
          <FileList
            files={st.conflicted}
            activeDiff={activeDiff}
            diffFor={(f) => ({ kind: 'working', path: f.path, staged: false, conflict: true })}
            menu={(f) => [
              { label: 'Garder ma version', onClick: () => ui.run('Résolution…', () => api.resolve(repo, f.path, 'mine')) },
              { label: 'Garder leur version', onClick: () => ui.run('Résolution…', () => api.resolve(repo, f.path, 'theirs')) },
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
            'separator',
            // Fichier non suivi : aucun historique. Fichier supprimé : blame de la version de HEAD.
            ...fileViewItems(ui, f.path, f.status === '?' || !snap.head ? false : null, f.status === '?' || !snap.head ? false : f.status === 'D' ? snap.head : null),
          ]}
        />
        {st.unstaged.length === 0 && <div className="empty">Rien à indexer</div>}
      </PanelSection>

      <PanelSection
        title="Indexés"
        count={st.staged.length}
        action={st.staged.length ? { label: 'Tout désindexer', onClick: () => ui.run('Désindexation…', () => api.unstage(repo, withOld(st.staged))) } : undefined}
      >
        <FileList
          files={st.staged}
          activeDiff={activeDiff}
          diffFor={(f) => ({ kind: 'working', path: f.path, oldPath: f.oldPath, staged: true })}
          action={{ label: 'Retirer', onClick: (f) => ui.run('Désindexation…', () => api.unstage(repo, withOld([f]))) }}
          menu={(f) =>
            // Fichier ajouté : pas encore d'historique. Renommage : historique et blame de l'ancien chemin (version de HEAD).
            f.status === 'A' || !snap.head
              ? fileViewItems(ui, f.path, false, false)
              : f.oldPath
                ? fileViewItems(ui, f.oldPath, null, snap.head)
                : fileViewItems(ui, f.path, null, f.status === 'D' ? snap.head : null)
          }
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
