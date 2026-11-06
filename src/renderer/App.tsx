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
import { loadPreferences, updatePreferences, usePreferences } from './prefs';
import { setCommandContext, type AppHooks } from './commands';
import {
  activeTab,
  clearPendingClose,
  closeTabById,
  getTabState,
  openRepoTab,
  requestCloseTab,
  restoreTabs,
  saveTabState,
  setTabsBusy,
  toSession,
  usePendingClose,
  useTabsBusy,
  useTabsModel,
  getTabsModel,
} from './tabs';
import { TabBar } from './components/TabBar';

export type Selection = { kind: 'wip' } | { kind: 'commit'; sha: string };

/**
 * Coquille de l'application : onglets, écran d'accueil d'un onglet vide, démarrage.
 * Un seul `RepoView` est monté (l'onglet actif) ; l'état des autres onglets est conservé dans `tabs.ts`.
 */
export function App() {
  const model = useTabsModel();
  const tab = activeTab(model);
  const busy = useTabsBusy();
  const [ready, setReady] = useState(false);
  // Erreur du dépôt passé en argument : montrée une seule fois, sur l'accueil de l'onglet actif au démarrage
  // (`tabId`) ou, si cet onglet affiche un dépôt restauré, dans un message temporaire.
  const [openError, setOpenError] = useState<{ text: string; tabId: number | null } | null>(null);

  useEffect(() => {
    (async () => {
      // Onglets de la session précédente, puis dépôt passé en argument (ouvert ou activé dans son onglet).
      try {
        if ((await loadPreferences()).restoreTabs) {
          const s = await api.restoreSession();
          if (s.repos.length) restoreTabs(s.repos, s.active);
        }
      } catch {
        // session illisible : on démarre sans onglet restauré
      }
      try {
        const p = await api.initialRepo();
        if (p) openRepoTab(p, 'new');
      } catch (e) {
        const t = activeTab(getTabsModel());
        setOpenError({ text: (e as Error).message, tabId: t && !t.repo ? t.id : null });
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const errorToast = openError && openError.tabId === null ? openError.text : null;
  useEffect(() => {
    if (!errorToast) return;
    const t = setTimeout(() => setOpenError(null), 9000);
    return () => clearTimeout(t);
  }, [errorToast]);

  // Session enregistrée à chaque changement d'onglets (après la restauration, pour ne pas l'écraser).
  const session = useMemo(() => toSession(model), [model]);
  const sessionKey = JSON.stringify(session);
  useEffect(() => {
    if (ready) api.saveSession(session.repos, session.active).catch(() => {});
  }, [ready, sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Onglet vide : le registre de commandes voit « aucun dépôt ».
  const emptyTab = !tab?.repo;
  useEffect(() => {
    if (emptyTab) setCommandContext({ ui: null, repo: null, snap: null, busy: null, app: SHELL_HOOKS });
  }, [emptyTab]);

  if (!ready) return <div className="app" />;
  // Barre masquée tant que seul l'écran d'accueil est ouvert.
  const showBar = model.tabs.length > 1 || !!tab?.repo;
  return (
    <div className="tabs-shell">
      {showBar && <TabBar model={model} busy={busy} />}
      <div className="tabs-content">
        {tab?.repo ? (
          <RepoView key={tab.id} tabId={tab.id} repo={tab.repo} onBusy={setTabsBusy} />
        ) : (
          <Welcome
            key={tab?.id}
            // L'ouverture vise l'onglet d'origine : rien ne se passe s'il a été fermé pendant un clonage.
            onOpen={(p) => {
              if (openRepoTab(p, 'current', tab?.id)) setOpenError(null);
            }}
            onBusy={setTabsBusy}
            initialError={openError && openError.tabId === tab?.id ? openError.text : null}
          />
        )}
      </div>
      {errorToast && (
        <div className="toast toast-error" onClick={() => setOpenError(null)}>
          {errorToast}
        </div>
      )}
    </div>
  );
}

/** Rappels des commandes quand aucun dépôt n'est affiché. */
const SHELL_HOOKS: AppHooks = {
  openRepo: (path) => openRepoTab(path, 'current'),
  closeRepo: () => requestCloseTab(),
  refresh: () => {},
  selectCommit: () => {},
  showDiff: () => {},
};

interface RepoViewProps {
  tabId: number;
  repo: string;
  /** Opération en cours (ou `null`) : la coquille bloque alors le changement et la fermeture d'onglet. */
  onBusy: (label: string | null) => void;
}

/** Un dépôt, affiché dans l'onglet actif. Son état d'affichage est relu puis enregistré dans `tabs.ts`. */
function RepoView({ tabId, repo, onBusy }: RepoViewProps) {
  const [saved] = useState(() => getTabState(tabId));
  const [snap, setSnap] = useState<RepoSnapshot | null>(saved?.snap ?? null);
  const [selection, setSelection] = useState<Selection>(saved?.selection ?? { kind: 'wip' });
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(saved?.diffTarget ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [draft, setDraft] = useState<CommitDraft>(saved?.draft ?? EMPTY_DRAFT);
  const [fileView, setFileView] = useState<FileViewTarget | null>(saved?.fileView ?? null);
  const closeFileView = useCallback(() => setFileView(null), []);
  // Autre dépôt dans cet onglet (barre d'outils) ou fermeture de l'onglet.
  // Refusé pendant une opération (sauf « Ouverture… ») : l'onglet et le message de résultat seraient perdus.
  const switchRepo = useCallback(
    (path: string) => {
      if (!openRepoTab(path, 'current', tabId)) setToast({ kind: 'error', text: 'Une opération est en cours : attendez sa fin pour changer de dépôt.' });
    },
    [tabId],
  );
  const closeRepo = useCallback(() => requestCloseTab(tabId), [tabId]);
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

  // Fermeture demandée alors que le brouillon de commit n'est pas vide : confirmation.
  const pendingClose = usePendingClose();
  useEffect(() => {
    if (pendingClose !== tabId) return;
    clearPendingClose();
    setPrompt({
      title: "Fermer l'onglet ?",
      message: `Le brouillon de commit de « ${repo.split(/[\\/]/).pop()} » n'est pas vide. Il pourra être retrouvé avec « Rouvrir l'onglet fermé ».`,
      confirm: "Fermer l'onglet",
      danger: true,
      onSubmit: () => closeTabById(tabId),
    });
  }, [pendingClose, tabId, repo]);

  // Premier affichage : état restauré de l'onglet (instantané en cache compris), puis relecture du dépôt.
  // Le dépôt d'un `RepoView` ne change pas en pratique (autre dépôt = autre identifiant d'onglet = autre montage) :
  // la remise à zéro ne s'applique qu'à un changement ultérieur, jamais à l'état restauré.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) firstLoad.current = false;
    else {
      setSnap(null);
      setSelection({ kind: 'wip' });
      setDiffTarget(null);
      setDraft(EMPTY_DRAFT);
      setFileView(null);
    }
    void refresh();
  }, [repo]); // eslint-disable-line react-hooks/exhaustive-deps

  // État d'affichage de l'onglet, relu quand il redevient actif.
  useEffect(() => {
    saveTabState(tabId, { selection, diffTarget, fileView, draft, snap });
  }, [tabId, selection, diffTarget, fileView, draft, snap]);

  // L'opération en cours est remontée à la coquille (et oubliée au démontage).
  useEffect(() => onBusy(busy), [busy, onBusy]);
  useEffect(() => () => onBusy(null), [onBusy]);

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
      snap,
      busy,
      app: {
        openRepo: switchRepo,
        closeRepo,
        refresh: () => void refresh(),
        selectCommit: (sha) => {
          setSelection({ kind: 'commit', sha });
          setDiffTarget(null);
          setFileView(null);
        },
        showDiff: (t) => ui.showDiff(t),
      },
    });
  }, [ui, repo, snap, busy, refresh, switchRepo, closeRepo]);

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

  const selectedCommit = selection.kind === 'commit' ? snap?.commits.find((c) => c.sha === selection.sha) : undefined;

  return (
    <UiContext.Provider value={ui}>
      <div className="app" onClick={() => setMenu(null)}>
        <Toolbar repo={repo} snap={snap} busy={busy} onClose={closeRepo} onSwitch={switchRepo} onRefresh={refresh} autoRefresh={autoRefresh} onToggleAuto={toggleAutoRefresh} />
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
