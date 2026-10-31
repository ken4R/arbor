import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffTarget, RepoSnapshot } from '../shared/types';
import { api } from './api';
import { layoutGraph } from './graph';
import { Welcome } from './components/Welcome';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { GraphView } from './components/GraphView';
import { WorkingPanel, EMPTY_DRAFT, type CommitDraft } from './components/WorkingPanel';
import { CommitPanel } from './components/CommitPanel';
import { DiffView } from './components/DiffView';
import { ContextMenu, type MenuState } from './components/ContextMenu';
import { PromptDialog, type PromptState } from './components/PromptDialog';
import { UiContext, type Ui } from './ui';

export type Selection = { kind: 'wip' } | { kind: 'commit'; sha: string };

export function App() {
  const [repo, setRepo] = useState<string | null>(null);
  const [snap, setSnap] = useState<RepoSnapshot | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: 'wip' });
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [draft, setDraft] = useState<CommitDraft>(EMPTY_DRAFT);
  const [openError, setOpenError] = useState<string | null>(null);
  const repoRef = useRef(repo);
  repoRef.current = repo;

  const refresh = useCallback(async () => {
    if (!repo) return;
    try {
      const next = await api.snapshot(repo);
      // Une réponse arrivée après un changement de dépôt est ignorée.
      if (repoRef.current === repo) setSnap(next);
    } catch (e) {
      if (repoRef.current === repo) setToast({ kind: 'error', text: (e as Error).message });
    }
  }, [repo]);

  useEffect(() => {
    api
      .initialRepo()
      .then((p) => p && setRepo(p))
      .catch((e) => setOpenError((e as Error).message));
  }, []);

  useEffect(() => {
    setSnap(null);
    setSelection({ kind: 'wip' });
    setDiffTarget(null);
    setDraft(EMPTY_DRAFT);
    void refresh();
  }, [repo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 9000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const ui: Ui = useMemo(
    () => ({
      async run(label, fn, success) {
        setBusy(label);
        setToast(null);
        try {
          await fn();
          if (success) setToast({ kind: 'ok', text: success });
          return true;
        } catch (e) {
          setToast({ kind: 'error', text: (e as Error).message });
          return false;
        } finally {
          setBusy(null);
          await refresh();
        }
      },
      openMenu: (e, items) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY, items });
      },
      ask: (p) => setPrompt(p),
      showDiff: setDiffTarget,
    }),
    [refresh],
  );

  const rows = useMemo(() => (snap ? layoutGraph(snap.commits) : []), [snap]);

  // Si le commit sélectionné disparaît (reset, rebase...), on revient au WIP.
  useEffect(() => {
    if (snap && selection.kind === 'commit' && !snap.commits.some((c) => c.sha === selection.sha)) {
      setSelection({ kind: 'wip' });
    }
  }, [snap, selection]);

  // Ferme le diff d'un fichier de travail qui n'a plus de modification de ce type (indexé, résolu, commité...).
  useEffect(() => {
    if (!snap || diffTarget?.kind !== 'working') return;
    const st = snap.status;
    const list = diffTarget.conflict ? st.conflicted : diffTarget.staged ? st.staged : st.unstaged;
    if (list.some((f) => f.path === diffTarget.path)) return;
    // Un fichier qui vient d'être indexé ou désindexé reste affiché de l'autre côté.
    const other = diffTarget.staged ? st.unstaged : st.staged;
    const moved = !diffTarget.conflict && other.find((f) => f.path === diffTarget.path);
    setDiffTarget(moved ? { kind: 'working', path: moved.path, staged: !diffTarget.staged, untracked: moved.status === '?' } : null);
  }, [snap, diffTarget]);

  if (!repo) return <Welcome onOpen={setRepo} initialError={openError} />;

  const selectedCommit = selection.kind === 'commit' ? snap?.commits.find((c) => c.sha === selection.sha) : undefined;

  return (
    <UiContext.Provider value={ui}>
      <div className="app" onClick={() => setMenu(null)}>
        <Toolbar repo={repo} snap={snap} busy={busy} onClose={() => setRepo(null)} onSwitch={setRepo} onRefresh={refresh} />
        <div className="main">
          {snap ? (
            <>
              <Sidebar snap={snap} onSelectCommit={(sha) => { setSelection({ kind: 'commit', sha }); setDiffTarget(null); }} />
              <div className="center">
                {diffTarget ? (
                  <DiffView repo={repo} target={diffTarget} onClose={() => setDiffTarget(null)} />
                ) : (
                  <GraphView
                    snap={snap}
                    rows={rows}
                    selection={selection}
                    onSelect={(s) => {
                      setSelection(s);
                      setDiffTarget(null);
                    }}
                  />
                )}
              </div>
              <aside className="right">
                {selection.kind === 'wip' || !selectedCommit ? (
                  <WorkingPanel repo={repo} snap={snap} activeDiff={diffTarget} draft={draft} onDraft={setDraft} />
                ) : (
                  <CommitPanel repo={repo} snap={snap} commit={selectedCommit} activeDiff={diffTarget} />
                )}
              </aside>
            </>
          ) : (
            <div className="loading">Chargement du dépôt…</div>
          )}
        </div>
        {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
        {prompt && <PromptDialog prompt={prompt} onClose={() => setPrompt(null)} />}
        {toast && (
          <div className={`toast toast-${toast.kind}`} onClick={() => setToast(null)}>
            {toast.text}
          </div>
        )}
      </div>
    </UiContext.Provider>
  );
}
