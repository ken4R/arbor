import { useEffect, useRef, useState } from 'react';
import type { ReflogEntry, ReflogKind, RepoSnapshot, UndoInfo } from '../../shared/types';
import { api } from '../api';
import type { Ui } from '../ui';
import { fullDate, relativeDate } from '../util';
import { Dialog } from './Dialog';

// Annulation par le reflog : bouton Annuler (dernière opération de la branche extraite, revérifiée par le main)
// et dialogue du reflog (états successifs d'une branche ou de HEAD, retour à l'un d'eux par `reset --keep`).

/** Entrées chargées à chaque page (= `REFLOG_PAGE` du main). */
const PAGE = 200;

const KIND_LABELS: Record<ReflogKind, string> = {
  commit: 'commit',
  amend: 'amend',
  merge: 'fusion',
  rebase: 'rebase',
  reset: 'reset',
  pull: 'pull',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
  checkout: 'checkout',
  other: 'autre',
};

const short = (sha: string) => sha.slice(0, 7);
/** Message du reflog raccourci pour une confirmation. */
const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 59).trimEnd()}…` : s);

/** Bouton Annuler possible : une branche extraite, au moins un commit, aucune opération en cours. */
export function canUndo(snap: RepoSnapshot | null): snap is RepoSnapshot {
  return !!snap && !!snap.head && !!snap.status.branch && snap.status.state === 'clean';
}

/** Annule la dernière opération de la branche extraite après confirmation (ou explique pourquoi c'est impossible). */
export async function undoLastAction(ui: Ui, snap: RepoSnapshot) {
  const repo = snap.path;
  let info: UndoInfo;
  try {
    info = await api.undoInfo(repo);
  } catch (e) {
    return openNothingToUndo(ui, snap, 'Annulation impossible', e instanceof Error ? e.message : String(e));
  }
  const { plan, head, branch } = info;
  if (!plan || !head || !branch) return openNothingToUndo(ui, snap, 'Rien à annuler', info.reason ?? 'Aucune opération à annuler.');
  const kept = plan.mode === 'soft' ? 'Les changements du commit annulé restent indexés.' : 'Les modifications locales sont conservées.';
  ui.ask({
    title: 'Annuler la dernière opération',
    message: `Annuler « ${plan.label} » : ${branch} revient à ${short(plan.target)}. ${kept} Les commits retirés restent dans le reflog.`,
    confirm: 'Revenir en arrière',
    onSubmit: () =>
      void ui.run('Annulation…', () => api.undoLast(repo, head, plan.target), `« ${plan.label} » annulé : ${branch} revient à ${short(plan.target)}`),
  });
}

function openNothingToUndo(ui: Ui, snap: RepoSnapshot, title: string, message: string) {
  ui.openDialog((close) => (
    <Dialog
      title={title}
      message={message}
      onClose={close}
      actions={
        <>
          <button type="button" className="btn" onClick={() => openReflogDialog(ui, snap)}>
            Voir le reflog…
          </button>
          <button type="button" className="btn btn-primary" onClick={close} autoFocus>
            Fermer
          </button>
        </>
      }
    />
  ));
}

/** Ouvre le reflog de la branche extraite (ou de HEAD en HEAD détachée). */
export function openReflogDialog(ui: Ui, snap: RepoSnapshot) {
  ui.openDialog((close) => <ReflogDialog ui={ui} snap={snap} onClose={close} />);
}

function ReflogDialog({ ui, snap, onClose }: { ui: Ui; snap: RepoSnapshot; onClose: () => void }) {
  const repo = snap.path;
  const branch = snap.status.branch;
  const [ref, setRef] = useState(branch ?? 'HEAD');
  const [entries, setEntries] = useState<ReflogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  // Chargement en cours : une réponse arrivée après un changement de référence est ignorée.
  const generation = useRef(0);

  const load = (r: string, skip: number) => {
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    api.reflog(repo, r, skip).then(
      (page) => {
        if (gen !== generation.current) return;
        setEntries((prev) => (skip === 0 ? page : [...prev, ...page]));
        setMore(page.length === PAGE);
        setLoading(false);
      },
      (e) => {
        if (gen !== generation.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    setEntries([]);
    setSelected(null);
    load(ref, 0);
  }, [ref]); // eslint-disable-line react-hooks/exhaustive-deps

  // La ligne sélectionnée reste visible quand elle change au clavier.
  useEffect(() => {
    if (selected === null) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const entry = selected === null ? null : (entries[selected] ?? null);
  const busy = snap.status.state !== 'clean';
  const current = entries[0]?.index === 0 ? entries[0].sha : snap.head;
  const resetDisabled = !entry || entry.sha === current || busy;
  const who = branch ? `La branche « ${branch} »` : 'HEAD (détachée)';

  const resetTo = () => {
    if (!entry || resetDisabled) return;
    ui.ask({
      title: 'Reset (keep) vers cet état',
      message:
        `${who} revient à ${short(entry.sha)} (${entry.selector} « ${clip(entry.subject)} »). Les commits qui n'y figurent pas ` +
        'quittent la branche mais restent dans le reflog. Les modifications locales sont conservées ; Git refuse si elles ' +
        'touchent un fichier qui change.',
      confirm: 'Reset (keep)',
      danger: true,
      onSubmit: () => {
        onClose();
        void ui.run('Reset (keep)…', () => api.reset(repo, entry.sha, 'keep'), `${branch ?? 'HEAD'} revient à ${short(entry.sha)}`);
      },
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!entries.length) return;
    const next = selected === null ? 0 : Math.max(0, Math.min(entries.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
    setSelected(next);
    list.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
  };

  return (
    <Dialog
      title="Reflog"
      message="États successifs de la référence, plus récent en haut. Choisissez-en un pour y ramener la branche (reset --keep)."
      onClose={onClose}
      className="reflog-dialog"
      actions={
        <>
          {busy && <span className="reflog-hint">Opération en cours : terminez-la avant de revenir à un état.</span>}
          <button type="button" className="btn" onClick={onClose}>
            Fermer
          </button>
          <button type="button" className="btn btn-danger" disabled={resetDisabled} onClick={resetTo}>
            Reset (keep) vers cet état…
          </button>
        </>
      }
    >
      {branch && (
        <div className="reflog-refs" role="radiogroup" aria-label="Référence">
          {[branch, 'HEAD'].map((r) => (
            <label key={r} className="check">
              <input type="radio" name="reflog-ref" checked={ref === r} onChange={() => setRef(r)} />
              {r === 'HEAD' ? 'HEAD (avec les checkouts)' : `Branche ${r}`}
            </label>
          ))}
        </div>
      )}
      <ul className="reflog-list" ref={list} onKeyDown={onKeyDown}>
        {entries.map((r, i) => (
          <li key={`${r.index}-${r.sha}`}>
            <button
              type="button"
              data-index={i}
              className={`reflog-row${i === selected ? ' selected' : ''}`}
              onClick={() => setSelected(i)}
              title={`${r.selector} — ${r.sha}`}
            >
              <span className="reflog-selector">{`@{${r.index}}`}</span>
              <code className="reflog-sha">{short(r.sha)}</code>
              <span className={`reflog-kind kind-${r.kind}`}>{KIND_LABELS[r.kind]}</span>
              <span className="reflog-subject">{r.subject || '(sans message)'}</span>
              {r.index === 0 && <span className="reflog-current">actuel</span>}
              <span className="reflog-date" title={r.date ? fullDate(r.date) : undefined}>
                {r.date ? relativeDate(r.date) : ''}
              </span>
            </button>
          </li>
        ))}
        {!loading && !error && entries.length === 0 && <li className="reflog-empty">Reflog vide pour {ref}.</li>}
        {error && <li className="reflog-empty reflog-error">{error}</li>}
        {loading && <li className="reflog-empty">Chargement…</li>}
        {more && !loading && (
          <li>
            <button type="button" className="link-btn reflog-more" onClick={() => load(ref, entries[entries.length - 1].index + 1)}>
              Charger les {PAGE} entrées suivantes
            </button>
          </li>
        )}
      </ul>
    </Dialog>
  );
}
