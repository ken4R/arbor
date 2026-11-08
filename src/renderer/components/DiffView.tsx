import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffTarget, PatchAction, PatchSelection } from '../../shared/types';
import { api } from '../api';
import { parseDiff, toSplit, type DiffLine } from '../diff';
import { useUi } from '../ui';
import { updatePreferences, usePreferences } from '../prefs';
import type { DiffMode } from '../../shared/prefs';
import { Icon } from './Icons';
import { MergeEditor } from './MergeEditor';

type Mode = DiffMode;

/**
 * `reloadKey` (facultatif) : pour un diff du répertoire de travail, toute nouvelle valeur recharge le diff
 * (après une indexation, un rafraîchissement…). La sélection de lignes est gardée si le diff n'a pas changé.
 */
export function DiffView({ repo, target, onClose, reloadKey }: { repo: string; target: DiffTarget; onClose: () => void; reloadKey?: unknown }) {
  if (target.kind === 'working' && target.conflict) {
    // Éditeur de fusion à trois panneaux ; vue simple en repli (binaire, trop gros, sous-module, lien symbolique).
    // `reloadKey` n'est pas transmis : un changement extérieur est détecté à l'enregistrement.
    const fallback = <ConflictView repo={repo} path={target.path} onClose={onClose} />;
    return <MergeEditor key={`${repo}\0${target.path}`} repo={repo} path={target.path} onClose={onClose} fallback={fallback} />;
  }
  return <PatchView repo={repo} target={target} onClose={onClose} reloadKey={reloadKey} />;
}

/** Clé d'une ligne sélectionnée : « bloc:ligne », indices dans `Hunk.lines`. */
const lineKey = (h: number, k: number) => `${h}:${k}`;

const ACTION_TEXT: Record<PatchAction, { verb: string; busy: string }> = {
  stage: { verb: 'Indexer', busy: 'Indexation…' },
  unstage: { verb: 'Désindexer', busy: 'Désindexation…' },
  discard: { verb: 'Annuler', busy: 'Annulation…' },
};

function PatchView({ repo, target, onClose, reloadKey }: { repo: string; target: DiffTarget; onClose: () => void; reloadKey?: unknown }) {
  const ui = useUi();
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mode: Mode = usePreferences().diffMode;
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<{ h: number; k: number } | null>(null);
  const shown = useRef<{ key: string; raw: string | null }>({ key: '', raw: null });
  const diff = useMemo(() => (raw === null ? null : parseDiff(raw)), [raw]);

  const targetKey = `${repo}\0${JSON.stringify(target)}`;
  const reload = target.kind === 'working' ? reloadKey : null;

  useEffect(() => {
    let alive = true;
    if (shown.current.key !== targetKey) {
      // Autre fichier : on repart de zéro. Simple rechargement : l'ancien diff reste affiché en attendant.
      shown.current = { key: targetKey, raw: null };
      setRaw(null);
      setError(null);
      setSelected(new Set());
      anchor.current = null;
    }
    api
      .diff(repo, target)
      .then((r) => {
        if (!alive) return;
        if (shown.current.raw !== r) {
          setSelected(new Set());
          anchor.current = null;
        }
        shown.current.raw = r;
        setError(null);
        setRaw(r);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [targetKey, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Indexation partielle : diff du répertoire de travail d'un fichier suivi, ni renommé ni binaire.
  const editable = target.kind === 'working' && !target.untracked && !target.conflict && !target.oldPath && !!diff && !diff.binary;
  const staged = target.kind === 'working' && target.staged;
  const linesSelectable = editable && mode === 'unified' && !diff?.newFile && !diff?.deletedFile;

  const apply = (sel: PatchSelection, action: PatchAction) => {
    if (raw === null) return;
    const shownRaw = raw;
    const go = () => ui.run(ACTION_TEXT[action].busy, () => api.applyPatchSelection(repo, target, shownRaw, sel, action));
    if (action !== 'discard') return void go();
    const count = sel.reduce((n, s) => n + (s.lines?.length ?? 0), 0);
    ui.ask({
      title: 'Annuler les modifications',
      message: sel.every((s) => !s.lines)
        ? `Les modifications de ce bloc de « ${target.path} » seront définitivement perdues.`
        : `Les modifications de ${count} ligne${count > 1 ? 's' : ''} de « ${target.path} » seront définitivement perdues.`,
      confirm: 'Annuler les modifications',
      danger: true,
      onSubmit: () => void go(),
    });
  };

  const toggleLine = (e: React.MouseEvent, h: number, k: number) => {
    if (!linesSelectable || !diff) return;
    e.preventDefault();
    const next = new Set(selected);
    const a = anchor.current;
    if (e.shiftKey && a && a.h === h) {
      // Maj+clic : sélectionne toutes les lignes modifiées entre l'ancre et la ligne cliquée.
      const [from, to] = a.k < k ? [a.k, k] : [k, a.k];
      for (let i = from; i <= to; i++) {
        const t = diff.hunks[h].lines[i].type;
        if (t === 'add' || t === 'del') next.add(lineKey(h, i));
      }
    } else {
      const key = lineKey(h, k);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      anchor.current = { h, k };
    }
    setSelected(next);
  };

  const lineSelection = (): PatchSelection => {
    const byHunk = new Map<number, number[]>();
    for (const key of selected) {
      const [h, k] = key.split(':').map(Number);
      byHunk.set(h, [...(byHunk.get(h) ?? []), k]);
    }
    return [...byHunk].map(([hunk, lines]) => ({ hunk, lines: lines.sort((x, y) => x - y) }));
  };
  const nSel = linesSelectable ? selected.size : 0;
  const plural = nSel > 1 ? 's' : '';

  // Échap ferme le diff, sauf si une surcouche (`[data-overlay]` : dialogue, menu, palette…) est ouverte.
  // Son état est relevé en capture, avant que React ne la ferme sur ce même Échap. Abonnement unique (`onClose`
  // lu par référence) : sinon le rendu provoqué par la fermeture réabonnerait un écouteur neuf pendant l'événement.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    let overlayOpen = false;
    const onCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') overlayOpen = !!document.querySelector('[data-overlay]');
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !overlayOpen && onCloseRef.current();
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const changeMode = (m: Mode) => updatePreferences({ diffMode: m }).catch(() => {}); // échec : l'affichage revient à la valeur enregistrée

  const context = target.kind === 'commit' ? `commit ${target.sha.slice(0, 7)}` : target.staged ? 'indexé' : 'non indexé';

  return (
    <div className="diff">
      <header className="diff-head">
        <div className="diff-title">
          <span className="diff-path">{target.path}</span>
          <span className="diff-context">{context}</span>
          {diff && (
            <span className="diff-stats">
              <span className="add">+{diff.additions}</span> <span className="del">−{diff.deletions}</span>
            </span>
          )}
        </div>
        {nSel > 0 && (
          <div className="patch-actions">
            {staged ? (
              <button className="btn btn-sm btn-primary" onClick={() => apply(lineSelection(), 'unstage')}>
                Désindexer {nSel} ligne{plural}
              </button>
            ) : (
              <>
                <button className="btn btn-sm btn-primary" onClick={() => apply(lineSelection(), 'stage')}>
                  Indexer {nSel} ligne{plural}
                </button>
                <button className="btn btn-sm patch-discard" onClick={() => apply(lineSelection(), 'discard')}>
                  Annuler {nSel} ligne{plural}…
                </button>
              </>
            )}
            <button className="link-btn" onClick={() => setSelected(new Set())}>
              Désélectionner
            </button>
          </div>
        )}
        <div className="seg">
          <button className={mode === 'unified' ? 'on' : ''} onClick={() => changeMode('unified')}>
            Unifié
          </button>
          <button className={mode === 'split' ? 'on' : ''} onClick={() => changeMode('split')}>
            Côte à côte
          </button>
        </div>
        <button className="icon-btn" title="Fermer (Échap)" onClick={onClose}>
          <Icon.close />
        </button>
      </header>
      <div className="diff-body">
        {error && <div className="empty">{error}</div>}
        {!diff && !error && <div className="empty">Chargement…</div>}
        {diff?.binary && <div className="empty">Fichier binaire : aperçu indisponible.</div>}
        {diff && !diff.binary && diff.hunks.length === 0 && (
          <div className="empty">{raw === '' && target.kind === 'working' ? 'Plus aucune modification ici.' : 'Aucune différence de contenu (mode ou renommage).'}</div>
        )}
        {linesSelectable && diff && diff.hunks.length > 0 && nSel === 0 && (
          <div className="patch-hint">Cliquez sur le numéro d'une ligne modifiée pour la sélectionner (Maj+clic : plage).</div>
        )}
        {diff?.hunks.map((h, i) => (
          <div className="hunk" key={i}>
            <div className="hunk-head">
              <span className="hunk-range">{h.header}</span>
              {editable && (
                <span className="hunk-actions">
                  {staged ? (
                    <button className="btn btn-sm" onClick={() => apply([{ hunk: i }], 'unstage')}>
                      Désindexer le bloc
                    </button>
                  ) : (
                    <>
                      <button className="btn btn-sm" onClick={() => apply([{ hunk: i }], 'stage')}>
                        Indexer le bloc
                      </button>
                      <button className="btn btn-sm patch-discard" onClick={() => apply([{ hunk: i }], 'discard')}>
                        Annuler le bloc…
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
            {mode === 'unified' ? (
              <table className="code">
                <tbody>
                  {h.lines.map((l, k) => {
                    const pickable = linesSelectable && (l.type === 'add' || l.type === 'del');
                    const on = pickable && selected.has(lineKey(i, k));
                    const pick = pickable ? (e: React.MouseEvent) => toggleLine(e, i, k) : undefined;
                    return (
                      <tr key={k} className={`ln-${l.type}${pickable ? ' pickable' : ''}${on ? ' picked' : ''}`}>
                        <td className="no" onMouseDown={pick}>
                          {l.oldNo ?? ''}
                        </td>
                        <td className="no" onMouseDown={pick}>
                          {l.newNo ?? ''}
                        </td>
                        <td className="sign" onMouseDown={pick}>
                          {on ? '✓' : l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}
                        </td>
                        <td className="txt">{l.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table className="code split">
                <tbody>
                  {toSplit(h.lines).map(([a, b], k) => (
                    <tr key={k}>
                      <Side line={a} no={a?.oldNo} />
                      <Side line={b} no={b?.newNo} />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Side({ line, no }: { line: DiffLine | null; no?: number }) {
  const cls = line ? `ln-${line.type}` : 'ln-empty';
  return (
    <>
      <td className={`no ${cls}`}>{no ?? ''}</td>
      <td className={`txt ${cls}`}>{line?.text ?? ''}</td>
    </>
  );
}

type Region = 'ours' | 'theirs' | 'marker' | null;

/** Affiche le fichier en conflit avec les deux versions mises en évidence. */
export function ConflictView({ repo, path, onClose }: { repo: string; path: string; onClose: () => void }) {
  const ui = useUi();
  const [lines, setLines] = useState<{ text: string; region: Region }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .readFile(repo, path)
      .then((content) => {
        let region: Region = null;
        const out = content.split('\n').map((text) => {
          if (text.startsWith('<<<<<<<')) {
            region = 'ours';
            return { text, region: 'marker' as Region };
          }
          if (text.startsWith('=======') && region) {
            region = 'theirs';
            return { text, region: 'marker' as Region };
          }
          if (text.startsWith('>>>>>>>') && region) {
            region = null;
            return { text, region: 'marker' as Region };
          }
          return { text, region };
        });
        if (alive) setLines(out);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, path]);

  const keep = async (side: 'mine' | 'theirs') => {
    if (await ui.run('Résolution…', () => api.resolve(repo, path, side))) onClose();
  };
  const count = lines?.filter((l) => l.text.startsWith('<<<<<<<')).length ?? 0;

  return (
    <div className="diff">
      <header className="diff-head">
        <div className="diff-title">
          <span className="diff-path">{path}</span>
          <span className="diff-context conflict-tag">{count} conflit{count > 1 ? 's' : ''}</span>
        </div>
        <button className="btn btn-sm conflict-ours" onClick={() => keep('mine')}>
          Garder ma version
        </button>
        <button className="btn btn-sm conflict-theirs" onClick={() => keep('theirs')}>
          Garder leur version
        </button>
        <button className="icon-btn" title="Fermer (Échap)" onClick={onClose}>
          <Icon.close />
        </button>
      </header>
      <div className="diff-body">
        {error && <div className="empty">{error}</div>}
        {lines && (
          <table className="code">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className={l.region ? `cf-${l.region}` : ''}>
                  <td className="no">{i + 1}</td>
                  <td className="txt">{l.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="conflict-hint">Modifiez le fichier dans votre éditeur puis marquez-le comme résolu, ou choisissez une version entière ci-dessus.</p>
      </div>
    </div>
  );
}
