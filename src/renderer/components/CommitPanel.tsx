import { useEffect, useState } from 'react';
import type { Commit, DiffTarget, FileChange, RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { useUi } from '../ui';
import { fullDate, hashColor, initials } from '../util';
import { FileList } from './FileList';
import { PanelSection } from './WorkingPanel';

export function CommitPanel({ repo, snap, commit, activeDiff }: { repo: string; snap: RepoSnapshot; commit: Commit; activeDiff: DiffTarget | null }) {
  const ui = useUi();
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setError(null);
    api
      .commitFiles(repo, commit.sha)
      .then((f) => alive && setFiles(f))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [repo, commit.sha]);

  const parents = commit.parents.map((p) => snap.commits.find((c) => c.sha === p)).filter(Boolean) as Commit[];

  return (
    <div className="panel commit-panel">
      <div className="commit-head">
        <div className="commit-sha" title="Copier le SHA" onClick={() => navigator.clipboard.writeText(commit.sha)}>
          commit <code>{commit.sha.slice(0, 10)}</code>
        </div>
        <h2 className="commit-subject">{commit.subject}</h2>
        {commit.body && <pre className="commit-body">{commit.body}</pre>}
        <div className="commit-author">
          <span className="avatar avatar-lg" style={{ background: hashColor(commit.email) }}>
            {initials(commit.author)}
          </span>
          <div>
            <div className="author-name">{commit.author}</div>
            <div className="author-meta">
              {commit.email} · {fullDate(commit.date)}
            </div>
          </div>
        </div>
        {parents.length > 0 && (
          <div className="commit-parents">
            {parents.length > 1 ? 'Parents' : 'Parent'} :{' '}
            {parents.map((p) => (
              <code key={p.sha} title={p.subject}>
                {p.sha.slice(0, 7)}
              </code>
            ))}
          </div>
        )}
      </div>
      <PanelSection title="Fichiers modifiés" count={files?.length ?? 0}>
        {error ? (
          <div className="empty">{error}</div>
        ) : files === null ? (
          <div className="empty">Chargement…</div>
        ) : (
          <FileList
            files={files}
            activeDiff={activeDiff}
            diffFor={(f) => ({ kind: 'commit', sha: commit.sha, path: f.path, oldPath: f.oldPath })}
          />
        )}
      </PanelSection>
      <div className="commit-actions">
        <button className="btn btn-sm" onClick={() => ui.run('Cherry-pick…', () => api.cherryPick(repo, commit.sha))} disabled={commit.sha === snap.head}>
          Cherry-pick
        </button>
        <button className="btn btn-sm" onClick={() => ui.run('Revert…', () => api.revert(repo, commit.sha))}>
          Revert
        </button>
      </div>
    </div>
  );
}
