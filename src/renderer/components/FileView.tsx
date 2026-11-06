import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Blame, FileRevision, RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { appendRevisions, groupBlame, isUncommitted, nextPageArgs } from '../blame';
import type { FileViewTarget, Ui } from '../ui';
import { fullDate, relativeDate } from '../util';
import type { MenuItem } from './ContextMenu';
import { DiffView } from './DiffView';
import { Icon } from './Icons';

const PAGE = 200;

interface Props {
  repo: string;
  snap: RepoSnapshot;
  target: FileViewTarget;
  onClose: () => void;
  onSelectCommit: (sha: string) => void;
}

/**
 * Entrées de menu « Historique du fichier » et « Blame ».
 * `history` / `blame` : révision de départ (null = HEAD / arbre de travail), false = entrée désactivée.
 */
export function fileViewItems(ui: Ui, path: string, history: string | null | false, blame: string | null | false): MenuItem[] {
  return [
    { label: 'Historique du fichier', disabled: history === false, onClick: () => history !== false && ui.showFile({ path, rev: history, blameRev: blame === false ? undefined : blame, tab: 'history' }) },
    { label: 'Blame', disabled: blame === false, onClick: () => blame !== false && ui.showFile({ path, rev: history === false ? blame : history, blameRev: blame, tab: 'blame' }) },
  ];
}

/** Vue en surcouche du centre : historique d'un fichier (avec diff de chaque version) ou blame ligne par ligne. */
export function FileView({ repo, snap, target, onClose, onSelectCommit }: Props) {
  const [tab, setTab] = useState(target.tab);
  const targetKey = JSON.stringify(target);
  useEffect(() => setTab(target.tab), [targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Échap ferme toute la vue, sauf si une surcouche (`[data-overlay]` : dialogue, menu…) est ouverte.
  // Écouté sur `document` en remontée : après les gestionnaires React (dialogue) et avant celui du diff intégré
  // (sur `window`), qui ne doit jamais masquer le diff. L'état du dialogue est relevé avant que React ne le ferme.
  useEffect(() => {
    let overlayOpen = false;
    const onCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') overlayOpen = !!document.querySelector('[data-overlay]');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!overlayOpen) onClose();
    };
    window.addEventListener('keydown', onCapture, true);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const blameRev = target.blameRev !== undefined ? target.blameRev : target.rev;
  const context = target.rev ? `depuis ${target.rev.slice(0, 7)}` : 'HEAD';

  return (
    <div className="file-view">
      <header className="diff-head">
        <div className="diff-title">
          <span className="diff-path">{target.path}</span>
          <span className="diff-context">{tab === 'history' ? context : blameRev ? `commit ${blameRev.slice(0, 7)}` : 'arbre de travail'}</span>
        </div>
        <div className="seg">
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
            Historique
          </button>
          <button className={tab === 'blame' ? 'on' : ''} onClick={() => setTab('blame')}>
            Blame
          </button>
        </div>
        <button className="icon-btn" title="Fermer (Échap)" onClick={onClose}>
          <Icon.close />
        </button>
      </header>
      {tab === 'history' ? (
        <HistoryTab repo={repo} snap={snap} path={target.path} rev={target.rev} onSelectCommit={onSelectCommit} />
      ) : (
        <BlameTab repo={repo} snap={snap} path={target.path} rev={blameRev} onSelectCommit={onSelectCommit} />
      )}
    </div>
  );
}

/** Empreinte des références : l'historique depuis HEAD change quand HEAD ou une branche bouge. */
function refsKey(snap: RepoSnapshot) {
  return `${snap.head}|${snap.branches.map((b) => `${b.name}:${b.sha}`).join(',')}`;
}

function HistoryTab({ repo, snap, path, rev, onSelectCommit }: { repo: string; snap: RepoSnapshot; path: string; rev: string | null; onSelectCommit: (sha: string) => void }) {
  const [revs, setRevs] = useState<FileRevision[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const request = useRef(0);
  const reloadKey = rev === null ? refsKey(snap) : rev;

  // Nouveau fichier : on repart de zéro (pas d'ancienne liste affichée pour un autre fichier).
  useEffect(() => {
    setRevs(null);
    setSelected(null);
  }, [repo, path, rev]);

  // Nombre de versions déjà chargées : un rechargement (HEAD ou branche déplacée) en recharge autant.
  const loaded = useRef(0);
  loaded.current = revs?.length ?? 0;

  /** Charge des pages à la suite de `from` jusqu'à atteindre `target` versions (ou la fin de l'historique). */
  const load = useCallback(
    async (from: FileRevision[], target: number) => {
      const id = ++request.current;
      setLoading(true);
      setError(null);
      try {
        let all = from;
        let hasMore = true;
        do {
          const last = all[all.length - 1];
          const args = last ? nextPageArgs(last) : { path, rev, skip: 0 };
          const page = await api.fileLog(repo, args.path, args.rev, args.skip);
          if (id !== request.current) return;
          all = appendRevisions(all, page);
          hasMore = page.length === PAGE;
        } while (hasMore && all.length < target);
        setRevs(all);
        setMore(hasMore);
        // Garde la version affichée si elle existe encore, sinon montre la plus récente.
        setSelected((s) => (s && all.some((r) => r.sha === s) ? s : all[0]?.sha ?? null));
      } catch (e) {
        if (id === request.current) setError((e as Error).message);
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [repo, path, rev],
  );

  useEffect(() => {
    void load([], Math.max(loaded.current, 1));
  }, [load, reloadKey]);

  const loadMore = () => {
    if (revs) void load(revs, revs.length + PAGE);
  };

  const current = revs?.find((r) => r.sha === selected);

  return (
    <div className="file-history">
      <div className="file-revs">
        <div className="panel-head">
          <span>
            Versions <span className="count">{revs ? `${revs.length}${more ? '+' : ''}` : ''}</span>
          </span>
          {loading && <span className="file-loading">Chargement…</span>}
        </div>
        {error && <div className="empty">{error}</div>}
        {revs && revs.length === 0 && !error && <div className="empty">Aucun commit ne modifie ce fichier.</div>}
        <ul className="rev-list">
          {revs?.map((r) => (
            <li
              key={r.sha}
              className={`rev${r.sha === selected ? ' active' : ''}`}
              onClick={() => {
                setSelected(r.sha);
                onSelectCommit(r.sha);
              }}
              title={`${r.subject}\n${r.author} · ${fullDate(r.date)}`}
            >
              <span className={`status status-${r.status}`}>{r.status}</span>
              <span className="rev-main">
                <span className="rev-subject">{r.subject}</span>
                <span className="rev-meta">
                  <code>{r.sha.slice(0, 7)}</code> · {r.author} · {relativeDate(r.date)}
                </span>
                {r.oldPath && <span className="rev-rename">{r.oldPath} → {r.path}</span>}
              </span>
            </li>
          ))}
        </ul>
        {more && (
          <button className="btn btn-sm rev-more" disabled={loading} onClick={loadMore}>
            Charger plus
          </button>
        )}
      </div>
      <div className="file-diff">
        {current ? (
          <DiffView repo={repo} target={{ kind: 'commit', sha: current.sha, path: current.path, oldPath: current.oldPath }} onClose={() => setSelected(null)} />
        ) : (
          <div className="empty">{revs?.length ? 'Sélectionnez une version pour voir ses modifications.' : ''}</div>
        )}
      </div>
    </div>
  );
}

function BlameTab({ repo, snap, path, rev, onSelectCommit }: { repo: string; snap: RepoSnapshot; path: string; rev: string | null; onSelectCommit: (sha: string) => void }) {
  const [blame, setBlame] = useState<Blame | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const request = useRef(0);

  // Blame de l'arbre de travail : rechargé si HEAD ou l'état du fichier change. Une révision fixe ne change jamais.
  const workingKey = useMemo(() => {
    if (rev !== null) return '';
    const st = snap.status;
    const entries = [...st.staged, ...st.unstaged, ...st.conflicted].filter((f) => f.path === path);
    return `${snap.head}|${JSON.stringify(entries)}`;
  }, [rev, snap, path]);

  useEffect(() => {
    setBlame(null);
  }, [repo, path, rev]);

  useEffect(() => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    api
      .blame(repo, path, rev)
      .then((b) => id === request.current && setBlame(b))
      .catch((e) => {
        if (id !== request.current) return;
        setBlame(null);
        setError((e as Error).message);
      })
      .finally(() => id === request.current && setLoading(false));
  }, [repo, path, rev, workingKey, nonce]);

  const groups = useMemo(() => (blame ? groupBlame(blame.lines) : []), [blame]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <div className="blame">
      <div className="blame-bar">
        <span className="diff-context">
          {blame ? `${blame.lines.length} ligne${blame.lines.length > 1 ? 's' : ''} · ${Object.keys(blame.commits).filter((s) => !isUncommitted(s)).length} commit(s)` : ''}
        </span>
        {loading && <span className="file-loading">Chargement…</span>}
        <button className="btn btn-sm" onClick={refresh} disabled={loading} title="Relancer le blame">
          <Icon.refresh /> Rafraîchir
        </button>
      </div>
      <div className="diff-body">
        {error && <div className="empty">{error}</div>}
        {blame && blame.lines.length === 0 && <div className="empty">Fichier vide.</div>}
        {blame && (
          <table className="code blame-code">
            <tbody>
              {groups.map((g) =>
                g.lines.map((l, k) => {
                  const c = blame.commits[g.sha];
                  const pending = isUncommitted(g.sha);
                  return (
                    <tr key={l.line} className={`${k === 0 ? 'blame-start' : ''}${pending ? ' blame-uncommitted' : ''}`}>
                      <td className="blame-gutter" title={k === 0 && c ? `${c.summary}\n${c.author} <${c.email}> · ${fullDate(c.date)}` : undefined}>
                        {k === 0 &&
                          (pending ? (
                            <span className="blame-info">Non commité</span>
                          ) : (
                            <span className="blame-info">
                              <button className="blame-sha" onClick={() => onSelectCommit(g.sha)}>
                                {g.sha.slice(0, 7)}
                              </button>
                              <span className="blame-author">{c?.author}</span>
                              <span className="blame-date">{c ? relativeDate(c.date) : ''}</span>
                            </span>
                          ))}
                      </td>
                      <td className="no">{l.line}</td>
                      <td className="txt">{l.text}</td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
