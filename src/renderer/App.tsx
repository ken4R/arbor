import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffTarget, RepoSnapshot } from '../shared/types';
import { api, onRepoChanged, onWatchLimited } from './api';
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
import { FileView } from './components/FileView';
import type { FileViewTarget } from './ui';
import { UiContext, type Ui } from './ui';
import { updatePreferences, usePreferences } from './prefs';
import { setCommandContext } from './commands';

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
  const [fileView, setFileView] = useState<FileViewTarget | null>(null);
  const closeFileView = useCallback(() => setFileView(null), []);
  const repoRef = useRef(repo);
  repoRef.current = repo;
  // Rafraîchissement automatique (préférence enregistrée, activé par défaut).
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const { autoRefresh } = usePreferences();
  const toggleAutoRefresh = () => updatePreferences({ autoRefresh: !autoRefresh }).catch(() => {}); // échec : l'interrupteur revient à la valeur enregistrée

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
    setFileView(null);
    void refresh();
  }, [repo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // Le processus principal signale les changements faits hors d'Arbor. Pendant une opération lancée depuis
  // l'UI, on ignore (ui.run rafraîchit à la fin) ; sinon un seul rafraîchissement à la fois, plus un au plus en attente.
  useEffect(() => {
    if (!repo || !autoRefresh) return;
    let running = false;
    let queued = false;
    let disposed = false;
    const scheduleRefresh = async () => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        do {
          queued = false;
          await refresh();
        } while (queued && !disposed);
      } finally {
        running = false;
      }
    };
    const off = onRepoChanged((ev) => {
      if (disposed || ev.repo !== repo || busyRef.current) return;
      void scheduleRefresh();
    });
    const offLimited = onWatchLimited((ev) => {
      if (!disposed && ev.repo === repo) setToast({ kind: 'error', text: ev.message });
    });
    api.watchRepo(repo).catch(() => {
      /* sans surveillance, le rafraîchissement au focus reste actif */
    });
    return () => {
      disposed = true;
      off();
      offLimited();
      api.unwatchRepo().catch(() => {});
    };
  }, [repo, autoRefresh]); // eslint-disable-line react-hooks/exhaustive-deps

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
      showDiff: (t) => {
        setFileView(null);
        setDiffTarget(t);
      },
      showFile: (v) => {
        setDiffTarget(null);
        setFileView(v);
      },
    }),
    [refresh],
  );

  const rows = useMemo(() => (snap ? layoutGraph(snap.commits) : []), [snap]);

  // Contexte publié pour le registre de commandes (palette, raccourcis).
  useEffect(() => {
    setCommandContext({
      ui: repo ? ui : null,
      repo,
      // Jamais l'instantané d'un autre dépôt (changement de dépôt en cours) : les actions utilisent `snap.path`.
      snap: snap && snap.path === repo ? snap : null,
      busy,
      app: {
        openRepo: (path) => setRepo(path),
        closeRepo: () => setRepo(null),
        refresh: () => void refresh(),
        selectCommit: (sha) => {
          setSelection({ kind: 'commit', sha });
          setDiffTarget(null);
          setFileView(null);
        },
        selectWip: () => {
          setSelection({ kind: 'wip' });
          setDiffTarget(null);
          setFileView(null);
        },
        showDiff: (t) => ui.showDiff(t),
      },
    });
  }, [ui, repo, snap, busy, refresh]);

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
        <Toolbar repo={repo} snap={snap} busy={busy} onClose={() => setRepo(null)} onSwitch={setRepo} onRefresh={refresh} autoRefresh={autoRefresh} onToggleAuto={toggleAutoRefresh} />
        <div className="main">
          {snap ? (
            <>
              <Sidebar snap={snap} onSelectCommit={(sha) => { setSelection({ kind: 'commit', sha }); setDiffTarget(null); setFileView(null); }} />
              <div className="center">
                {diffTarget ? (
                  <DiffView repo={repo} target={diffTarget} onClose={() => setDiffTarget(null)} reloadKey={snap} />
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
                {fileView && (
                  <FileView repo={repo} snap={snap} target={fileView} onClose={closeFileView} onSelectCommit={(sha) => setSelection({ kind: 'commit', sha })} />
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
