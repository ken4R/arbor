import { useEffect, useMemo, useRef, useState } from 'react';
import { REBASE_ACTIONS, defaultGroupMessage, rebaseGroups, resultCount, validateSteps, type RebaseAction, type RebaseStep } from '../../shared/rebase';
import type { RebasePlan, RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { useUi, type Ui } from '../ui';
import { Dialog } from './Dialog';
import { IconRebaseGrip } from './Icons';

// Planificateur du rebase interactif : liste des commits `base..HEAD`, plus récent en haut (comme le graphe).
// L'ordre interne (`order`) est celui de Git, plus ancien d'abord ; l'affichage l'inverse.
// « squash »/« fixup » fusionnent un commit avec celui affiché en dessous (le précédent pour Git).

const ACTION_LABEL: Record<RebaseAction, string> = {
  pick: 'pick · garder',
  reword: 'reword · reformuler',
  edit: 'edit · arrêter pour modifier',
  squash: 'squash · fusionner + messages',
  fixup: 'fixup · fusionner sans message',
  drop: 'drop · supprimer',
};

const ACTION_KEYS: Record<string, RebaseAction> = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };

const fullMessage = (c: { subject: string; body: string }) => (c.body ? `${c.subject}\n\n${c.body}` : c.subject);

/** Ouvre le planificateur ; `base` = branche ou commit sur lequel rejouer, `ancestorOnly` : `base` doit être un ancêtre de HEAD. */
export function openRebaseDialog(ui: Ui, snap: RepoSnapshot, base: string, label: string, ancestorOnly = false) {
  ui.openDialog((close) => <RebaseDialog repo={snap.path} base={base} label={label} ancestorOnly={ancestorOnly} onClose={close} />);
}

interface Props {
  repo: string;
  base: string;
  label: string;
  ancestorOnly: boolean;
  onClose: () => void;
}

export function RebaseDialog({ repo, base, label, ancestorOnly, onClose }: Props) {
  const [plan, setPlan] = useState<RebasePlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.rebasePlan(repo, base, ancestorOnly).then(
      (p) => live && setPlan(p),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [repo, base, ancestorOnly]);

  if (!plan)
    return (
      <Dialog title={`Rebase interactif sur ${label}`} onClose={onClose} className="rebase-dialog">
        {error ? <p className="rebase-error">{error}</p> : <p className="dialog-msg">Chargement des commits…</p>}
      </Dialog>
    );
  return <RebasePlanner repo={repo} label={label} plan={plan} onClose={onClose} />;
}

function RebasePlanner({ repo, label, plan, onClose }: { repo: string; label: string; plan: RebasePlan; onClose: () => void }) {
  const ui = useUi();
  const bySha = useMemo(() => new Map(plan.commits.map((c) => [c.sha, c])), [plan]);
  const initialOrder = useMemo(() => plan.commits.map((c) => c.sha), [plan]);
  const [order, setOrder] = useState<string[]>(initialOrder);
  const [actions, setActions] = useState<Record<string, RebaseAction>>({});
  // Messages modifiés à la main, par commit porteur du message (voir `rebaseGroups`).
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [focusSha, setFocusSha] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ sha: string; after: boolean } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const display = useMemo(() => [...order].reverse(), [order]);
  const baseSteps: RebaseStep[] = order.map((sha) => ({ sha, action: actions[sha] ?? 'pick' }));
  const groups = rebaseGroups(baseSteps);
  const messageOf = (sha: string) => fullMessage(bySha.get(sha) ?? { subject: '', body: '' });
  // Message affiché pour chaque commit porteur : saisi, sinon pré-rempli (reword : son message ; squash : concaténation).
  const ownerMessage = new Map<string, string>();
  for (const g of groups) {
    if (g.owner === null) continue;
    const sha = order[g.owner];
    ownerMessage.set(sha, custom[sha] ?? defaultGroupMessage(baseSteps, g, messageOf));
  }
  const steps: RebaseStep[] = baseSteps.map((s) => (ownerMessage.has(s.sha) ? { ...s, message: ownerMessage.get(s.sha) } : s));
  const invalid = validateSteps(steps);
  const changed = order.some((sha, i) => sha !== initialOrder[i]) || steps.some((s) => s.action !== 'pick');
  const allDropped = steps.every((s) => s.action === 'drop');
  const published = plan.commits.filter((c) => c.published).length;

  useEffect(() => {
    if (focusSha) rowRefs.current.get(focusSha)?.focus();
  }, [focusSha, order]);

  const setAction = (sha: string, a: RebaseAction) => setActions((prev) => ({ ...prev, [sha]: a }));

  /** Déplace un commit d'un cran dans l'affichage (`delta` = -1 vers le haut, +1 vers le bas). */
  const moveBy = (sha: string, delta: number) => {
    const d = [...display];
    const i = d.indexOf(sha);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= d.length) return;
    [d[i], d[j]] = [d[j], d[i]];
    setOrder(d.reverse());
    setFocusSha(sha);
  };

  const dropOn = (target: string, after: boolean) => {
    if (!dragging || dragging === target) return;
    const d = display.filter((s) => s !== dragging);
    const i = d.indexOf(target);
    d.splice(after ? i + 1 : i, 0, dragging);
    setOrder(d.reverse());
    setFocusSha(dragging);
  };

  const onRowKey = (e: React.KeyboardEvent, sha: string) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey) return;
    const i = display.indexOf(sha);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      if (e.altKey) moveBy(sha, delta);
      else {
        const next = display[i + delta];
        if (next) rowRefs.current.get(next)?.focus();
      }
      return;
    }
    const a = !e.altKey && ACTION_KEYS[e.key.toLowerCase()];
    if (a) {
      e.preventDefault();
      setAction(sha, a);
    }
  };

  const close = () => {
    if (!changed) return onClose();
    ui.ask({
      title: 'Abandonner le rebase interactif',
      message: 'Les changements faits dans la liste (ordre, actions, messages) seront perdus.',
      confirm: 'Abandonner les changements',
      danger: true,
      onSubmit: onClose,
    });
  };

  const start = () => {
    if (invalid || plan.dirty || !changed) return;
    const stops = steps.some((s) => s.action === 'edit');
    const go = () => {
      onClose();
      void ui.run('Rebase interactif…', () => api.rebaseInteractive(repo, plan.upstream, plan.head, steps), stops ? undefined : 'Rebase interactif terminé');
    };
    if (!allDropped) return go();
    ui.ask({
      title: 'Supprimer tous les commits',
      message: `Les ${steps.length} commits seront retirés de « ${plan.branch ?? 'HEAD'} », qui reviendra à ${plan.upstream.slice(0, 7)}. Ils restent récupérables par le reflog.`,
      confirm: 'Tout supprimer',
      danger: true,
      onSubmit: go,
    });
  };

  const n = plan.commits.length;
  const after = resultCount(steps);
  const ownerSet = new Set(groups.flatMap((g) => (g.owner === null ? [] : [order[g.owner]])));
  const merged = new Set(groups.flatMap((g) => g.members.map((m) => order[m])));

  return (
    <Dialog
      title={`Rebase interactif sur ${label}`}
      message={
        <>
          « {plan.branch ?? 'HEAD détachée'} » : {n} commit{n > 1 ? 's' : ''} après <code>{plan.upstream.slice(0, 7)}</code>. Plus récent en haut ; « squash » et « fixup »
          fusionnent un commit avec celui du dessous.
        </>
      }
      onClose={close}
      onSubmit={start}
      submitLabel="Démarrer le rebase"
      submitDisabled={!!invalid || plan.dirty || !changed}
      danger={allDropped}
      className="rebase-dialog"
    >
      <ul className="rebase-list" role="listbox" aria-label="Commits à réécrire">
        {display.map((sha) => {
          const c = bySha.get(sha)!;
          const action = actions[sha] ?? 'pick';
          const target = dropAt?.sha === sha ? (dropAt.after ? ' drop-after' : ' drop-before') : '';
          return (
            <li
              key={sha}
              className={`rebase-item action-${action}${merged.has(sha) ? ' merged' : ''}${dragging === sha ? ' dragging' : ''}${target}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const afterHalf = e.clientY > r.top + r.height / 2;
                if (dropAt?.sha !== sha || dropAt.after !== afterHalf) setDropAt({ sha, after: afterHalf });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dropAt) dropOn(dropAt.sha, dropAt.after);
                setDragging(null);
                setDropAt(null);
              }}
            >
              <div
                className="rebase-row"
                tabIndex={0}
                role="option"
                aria-selected={focusSha === sha}
                draggable
                ref={(el) => {
                  if (el) rowRefs.current.set(sha, el);
                  else rowRefs.current.delete(sha);
                }}
                onFocus={() => setFocusSha(sha)}
                onKeyDown={(e) => onRowKey(e, sha)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', sha);
                  setDragging(sha);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropAt(null);
                }}
              >
                <span className="rebase-grip" title="Glisser pour déplacer (ou Alt+↑/↓)">
                  <IconRebaseGrip />
                </span>
                <select
                  className="rebase-action"
                  value={action}
                  aria-label={`Action pour ${sha.slice(0, 7)}`}
                  onChange={(e) => setAction(sha, e.target.value as RebaseAction)}
                >
                  {REBASE_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABEL[a]}
                    </option>
                  ))}
                </select>
                <code className="rebase-sha">{sha.slice(0, 7)}</code>
                <span className="rebase-subject" title={fullMessage(c)}>
                  {c.subject}
                </span>
                {c.published && (
                  <span className="rebase-published" title="Déjà présent sur la branche distante suivie">
                    publié
                  </span>
                )}
              </div>
              {ownerSet.has(sha) && (
                <label className="field rebase-message">
                  <span>{merged.has(sha) ? 'Message du commit fusionné' : 'Nouveau message'}</span>
                  <textarea
                    rows={Math.min(8, Math.max(3, (ownerMessage.get(sha) ?? '').split('\n').length + 1))}
                    value={ownerMessage.get(sha) ?? ''}
                    spellCheck={false}
                    onChange={(e) => setCustom((prev) => ({ ...prev, [sha]: e.target.value }))}
                  />
                </label>
              )}
            </li>
          );
        })}
      </ul>
      <p className="rebase-help">Glisser-déposer ou Alt+↑/↓ pour déplacer · ↑/↓ pour parcourir · p r e s f d pour changer l’action</p>
      <p className="rebase-summary">
        {n} commit{n > 1 ? 's' : ''} → {after}
      </p>
      {published > 0 && changed && (
        <p className="rebase-warning">
          {published} commit{published > 1 ? 's sont déjà publiés' : ' est déjà publié'} : après le rebase, il faudra forcer le push, et les autres personnes
          devront se resynchroniser.
        </p>
      )}
      {plan.dirty && <p className="rebase-error">Des modifications locales sont en cours : commitez-les ou mettez-les de côté (stash) avant le rebase.</p>}
      {!plan.dirty && invalid && <p className="rebase-error">{invalid}</p>}
    </Dialog>
  );
}
