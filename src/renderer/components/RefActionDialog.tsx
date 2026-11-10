import { useMemo, useState } from 'react';
import type { RepoSnapshot } from '../../shared/types';
import { dropActions, runRefAction, type DragRef, type DropTarget } from '../refDrop';
import type { Ui } from '../ui';
import { Dialog } from './Dialog';

// Alternative au clavier du glisser-déposer : on choisit la source et la cible, les actions proposées sont exactement
// celles du menu de dépôt (`dropActions`).

/** Ouvre le dialogue ; `source` absente = branche courante (ou première branche locale). */
export function openRefActionDialog(ui: Ui, snap: RepoSnapshot, source: DragRef | null) {
  ui.openDialog((close) => <RefActionDialog ui={ui} snap={snap} source={source} onClose={close} />);
}

const refKey = (r: DragRef) => `${r.remote ? 'r' : 'l'}:${r.name}`;
const fromKey = (k: string): DragRef => ({ remote: k.startsWith('r:'), name: k.slice(2) });

interface Props {
  ui: Ui;
  snap: RepoSnapshot;
  source: DragRef | null;
  onClose: () => void;
}

export function RefActionDialog({ ui, snap, source, onClose }: Props) {
  const locals = snap.branches.filter((b) => !b.remote);
  const remoteBranches = snap.branches.filter((b) => b.remote && !b.name.endsWith('/HEAD'));
  const current = snap.status.branch;
  const initialSource = source ?? (current ? { name: current, remote: false } : locals[0] ? { name: locals[0].name, remote: false } : null);
  const [src, setSrc] = useState(initialSource ? refKey(initialSource) : '');
  // Cible par défaut : la branche courante, sinon la première autre branche locale.
  const [tgt, setTgt] = useState(() => {
    const other = current && current !== initialSource?.name ? current : locals.find((b) => b.name !== initialSource?.name)?.name;
    return other ? `b:${other}` : snap.remotes[0] ? `remote:${snap.remotes[0].name}` : 'commit';
  });
  const [shaText, setShaText] = useState('');

  // Cible « commit » : préfixe de SHA (4 caractères au moins) qui désigne un seul commit chargé.
  const commitMatch = useMemo(() => {
    const t = shaText.trim().toLowerCase();
    if (t.length < 4 || !/^[0-9a-f]+$/.test(t)) return { sha: null, error: t ? 'Saisissez au moins 4 caractères hexadécimaux.' : null };
    const found = snap.commits.filter((c) => c.sha.startsWith(t));
    if (found.length === 1) return { sha: found[0].sha, subject: found[0].subject, error: null };
    return { sha: null, error: found.length ? 'Plusieurs commits commencent ainsi : précisez.' : 'Aucun commit du graphe chargé ne commence ainsi.' };
  }, [shaText, snap]);

  const target: DropTarget | null = tgt.startsWith('b:')
    ? { kind: 'branch', name: tgt.slice(2), remote: false }
    : tgt.startsWith('remote:')
      ? { kind: 'remote', name: tgt.slice(7) }
      : commitMatch.sha
        ? { kind: 'commit', sha: commitMatch.sha }
        : null;
  const actions = src && target ? dropActions(snap, fromKey(src), target) : [];

  return (
    <Dialog title="Fusionner, rebaser ou pousser" onClose={onClose} className="ref-action-dialog">
      <label className="field">
        <span>Branche à déplacer, fusionner ou pousser</span>
        <select value={src} onChange={(e) => setSrc(e.target.value)}>
          <optgroup label="Branches locales">
            {locals.map((b) => (
              <option key={b.name} value={refKey({ name: b.name, remote: false })}>
                {b.name}
                {b.current ? ' (courante)' : ''}
              </option>
            ))}
          </optgroup>
          {remoteBranches.length > 0 && (
            <optgroup label="Branches distantes">
              {remoteBranches.map((b) => (
                <option key={b.name} value={refKey({ name: b.name, remote: true })}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <label className="field">
        <span>Cible</span>
        <select value={tgt} onChange={(e) => setTgt(e.target.value)}>
          <optgroup label="Branches locales">
            {locals.map((b) => (
              <option key={b.name} value={`b:${b.name}`}>
                {b.name}
                {b.current ? ' (courante)' : ''}
              </option>
            ))}
          </optgroup>
          {snap.remotes.length > 0 && (
            <optgroup label="Remotes (pousser)">
              {snap.remotes.map((r) => (
                <option key={r.name} value={`remote:${r.name}`}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
          <option value="commit">Commit (SHA)…</option>
        </select>
      </label>
      {tgt === 'commit' && (
        <label className="field">
          <span>SHA du commit</span>
          <input autoFocus value={shaText} onChange={(e) => setShaText(e.target.value)} spellCheck={false} placeholder="ex. 1a2b3c4" />
          {commitMatch.sha ? (
            <small className="ref-action-commit">
              {commitMatch.sha.slice(0, 7)} « {commitMatch.subject} »
            </small>
          ) : (
            commitMatch.error && <small className="ref-action-error">{commitMatch.error}</small>
          )}
        </label>
      )}
      <div className="ref-action-list" role="group" aria-label="Actions possibles">
        {target && actions.length === 0 && <p className="dialog-msg">Aucune action possible entre ces deux références.</p>}
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`ref-action${a.danger ? ' danger' : ''}`}
            disabled={!!a.disabledReason}
            onClick={() => {
              onClose();
              runRefAction(ui, snap, a);
            }}
          >
            <span>{a.label}</span>
            {a.disabledReason && <small>{a.disabledReason}</small>}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
