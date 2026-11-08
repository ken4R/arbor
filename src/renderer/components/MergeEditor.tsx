import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { blockSide, composeResult, isMarkerLine, merge3, resolveBlock, splitLines, type Choice, type MergeBlock } from '../../shared/merge3';
import type { ConflictVersions } from '../../shared/types';
import { api } from '../api';
import { useUi } from '../ui';
import { Icon } from './Icons';

// Éditeur de fusion à trois panneaux : ma version | base | leur version en haut (alignées bloc par bloc, un seul
// défilement), résultat en bas avec un segment éditable par bloc. Les blocs sans conflit sont appliqués d'office.
// Le résultat n'est écrit qu'à l'enregistrement ; le main refuse si le fichier a changé depuis le chargement.

type Side = 'mine' | 'base' | 'theirs';

/** Brouillon par fichier (`repo\0chemin`), gardé tant qu'Arbor est ouvert : survit au changement d'onglet ou de fichier. */
interface Draft {
  /** Empreinte des trois versions : un brouillon ne s'applique qu'aux mêmes versions. */
  source: string;
  choices: [number, Choice][];
  /** Empreinte attendue du fichier de l'arbre de travail à l'enregistrement. */
  hash: string | null;
  /** Choix non enregistrés. Un brouillon enregistré n'est repris que si le fichier n'a pas changé depuis. */
  dirty: boolean;
}
const drafts = new Map<string, Draft>();

/** Empreinte rapide (FNV-1a 32 bits) des trois versions. */
function sourceKey(v: ConflictVersions): string {
  let h = 0x811c9dc5;
  const text = `${v.base ?? '\u0001'}\u0000${v.mine ?? '\u0001'}\u0000${v.theirs ?? '\u0001'}`;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

interface Model {
  blocks: MergeBlock[];
  eol: '\n' | '\r\n';
  finalNewline: boolean;
}

function buildModel(v: ConflictVersions): Model {
  const mine = splitLines(v.mine ?? '');
  const theirs = splitLines(v.theirs ?? '');
  // Fin de ligne et saut final de ma version ; si elle n'a qu'une ligne (aucune fin de ligne), ceux de la leur.
  const ref = mine.lines.length > 1 || mine.finalNewline ? mine : theirs.lines.length ? theirs : mine;
  return { blocks: merge3(splitLines(v.base ?? '').lines, mine.lines, theirs.lines), eol: ref.eol, finalNewline: ref.finalNewline };
}

const CHOICES: { choice: Choice; label: string; title: string; key?: string }[] = [
  { choice: 'mine', label: 'Ma version', title: 'Garder ma version de ce bloc', key: 'Alt+1' },
  { choice: 'theirs', label: 'Leur version', title: 'Garder leur version de ce bloc', key: 'Alt+2' },
  { choice: 'mine-theirs', label: 'Les deux', title: 'Ma version puis la leur', key: 'Alt+3' },
  { choice: 'theirs-mine', label: 'Les deux (leur d’abord)', title: 'Leur version puis la mienne' },
  { choice: 'base', label: 'Base', title: 'Revenir à la version d’origine (base)' },
];

const KIND_LABEL: Record<Exclude<MergeBlock['kind'], 'same'>, string> = {
  mine: 'Modifié dans ma version',
  theirs: 'Modifié dans leur version',
  both: 'Même modification des deux côtés',
  conflict: 'Conflit',
};

/** Classe de teinte d'une cellule des panneaux du haut. */
function cellTone(b: MergeBlock, side: Side): string {
  if (b.kind === 'same') return '';
  if (side === 'base') return 'mg-base';
  if (b.kind === 'both') return 'mg-both';
  if (b.kind === 'conflict') return side === 'mine' ? 'mg-ours' : 'mg-theirs';
  return b.kind === side ? (side === 'mine' ? 'mg-ours' : 'mg-theirs') : '';
}

const COLLAPSE_AT = 8; // bloc identique plus long : replié dans les panneaux du haut
const COLLAPSE_KEEP = 3;

export function MergeEditor({ repo, path, onClose, fallback }: { repo: string; path: string; onClose: () => void; fallback: React.ReactNode }) {
  const ui = useUi();
  const draftKey = `${repo}\0${path}`;
  const [versions, setVersions] = useState<ConflictVersions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [choices, setChoices] = useState<Map<number, Choice>>(() => new Map());
  const [hash, setHash] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [width, setWidth] = useState(0); // largeur du résultat : recalcul de la hauteur des segments
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  const segs = useRef(new Map<number, HTMLElement>());
  const done = useRef(false); // fichier résolu : ne plus écrire de brouillon

  // Chargement (et « Recharger », qui abandonne le brouillon). Les rafraîchissements du dépôt sont ignorés :
  // un changement extérieur est détecté à l'enregistrement par l'empreinte.
  useEffect(() => {
    let alive = true;
    setVersions(null);
    setError(null);
    api
      .conflictVersions(repo, path)
      .then((v) => {
        if (!alive) return;
        if (reloads > 0) drafts.delete(draftKey);
        const d = drafts.get(draftKey);
        const reuse = d && d.source === sourceKey(v) && (d.dirty || d.hash === v.workingHash);
        setChoices(new Map(reuse ? d.choices : []));
        setHash(reuse ? d.hash : v.workingHash);
        setDirty(reuse ? d.dirty : false);
        setExpanded(new Set());
        setVersions(v);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, path, reloads]); // eslint-disable-line react-hooks/exhaustive-deps

  const mode = !versions
    ? null
    : versions.unsupported
      ? 'fallback'
      : versions.mine === null || versions.theirs === null
        ? 'deletion'
        : versions.binary || versions.tooLarge
          ? 'fallback'
          : 'merge';
  const model = useMemo(() => (versions && mode === 'merge' ? buildModel(versions) : null), [versions, mode]);
  const conflicts = useMemo(() => (model ? model.blocks.flatMap((b, i) => (b.kind === 'conflict' ? [i] : [])) : []), [model]);
  const remaining = conflicts.filter((i) => !choices.has(i)).length;

  // Brouillon à jour à chaque changement.
  useEffect(() => {
    if (!versions || !model || done.current) return;
    drafts.set(draftKey, { source: sourceKey(versions), choices: [...choices], hash, dirty });
  }, [versions, model, choices, hash, dirty, draftKey]);

  // Premier conflit sélectionné et affiché au chargement.
  useLayoutEffect(() => {
    if (!model) return;
    const first = conflicts.find((i) => !choices.has(i)) ?? conflicts[0] ?? null;
    setCurrent(first);
    if (first !== null) requestAnimationFrame(() => reveal(first));
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  // Largeur du résultat suivie pour la hauteur automatique des segments.
  useEffect(() => {
    const el = bottom.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [model]);

  // Défilement synchronisé haut/bas, bloc par bloc (position relative dans le bloc visible en haut de chaque panneau).
  const lock = useRef({ top: 0, bottom: 0 });
  const headHeight = () => (top.current?.querySelector('.mg-colhead') as HTMLElement | null)?.offsetHeight ?? 0;
  const sync = (from: 'top' | 'bottom') => {
    const src = from === 'top' ? top.current : bottom.current;
    const dst = from === 'top' ? bottom.current : top.current;
    if (!src || !dst || !model || performance.now() < lock.current[from]) return;
    const [srcEls, dstEls] = from === 'top' ? [rows.current, segs.current] : [segs.current, rows.current];
    const y = src.scrollTop + (from === 'top' ? headHeight() : 0);
    let i = 0;
    for (let k = 0; k < model.blocks.length; k++) {
      const el = srcEls.get(k);
      if (el && el.offsetTop <= y) i = k;
      else if (el) break;
    }
    const s = srcEls.get(i);
    const d = dstEls.get(i);
    if (!s || !d) return;
    const frac = s.offsetHeight ? Math.min(1, (y - s.offsetTop) / s.offsetHeight) : 0;
    lock.current[from === 'top' ? 'bottom' : 'top'] = performance.now() + 120;
    dst.scrollTop = d.offsetTop + frac * d.offsetHeight - (from === 'top' ? 0 : headHeight());
  };
  /** Amène un bloc en vue dans les deux panneaux. */
  const reveal = (i: number) => {
    const r = rows.current.get(i);
    const s = segs.current.get(i);
    const until = performance.now() + 150;
    lock.current = { top: until, bottom: until };
    if (r && top.current) top.current.scrollTop = r.offsetTop - headHeight() - 24;
    if (s && bottom.current) bottom.current.scrollTop = s.offsetTop - 24;
  };

  const choose = (i: number, c: Choice | null) => {
    const next = new Map(choices);
    if (c === null) next.delete(i);
    else next.set(i, c);
    setChoices(next);
    setDirty(true);
    setCurrent(i);
  };
  const edit = (i: number, value: string) => choose(i, { custom: value === '' ? [] : value.split('\n') });

  const goConflict = (dir: 1 | -1) => {
    if (!conflicts.length) return;
    const pos = current === null ? -1 : current;
    const next = dir > 0 ? (conflicts.find((i) => i > pos) ?? conflicts[0]) : ([...conflicts].reverse().find((i) => i < (current ?? Infinity)) ?? conflicts[conflicts.length - 1]);
    setCurrent(next);
    reveal(next);
  };

  const save = (mark: boolean) => {
    if (!model) return;
    const content = composeResult(model.blocks, choices, model.eol, model.finalNewline);
    const go = async () => {
      let saved: string | null = null;
      const ok = await ui.run(
        mark ? 'Résolution…' : 'Enregistrement…',
        async () => {
          saved = await api.saveResolution(repo, path, content, hash, mark);
        },
        mark ? `« ${path} » est résolu.` : `« ${path} » est enregistré (toujours en conflit).`,
      );
      if (!ok) return;
      if (mark) {
        done.current = true;
        drafts.delete(draftKey);
        onClose();
      } else {
        setHash(saved);
        setDirty(false);
      }
    };
    const suspicious = [...choices.values()].some((c) => typeof c === 'object' && c.custom.some(isMarkerLine));
    if (mark && suspicious) {
      ui.ask({
        title: 'Marqueurs de conflit dans le résultat',
        message: 'Un texte saisi contient encore une ligne qui ressemble à un marqueur de conflit (<<<<<<<, =======, >>>>>>>). Marquer le fichier comme résolu quand même ?',
        confirm: 'Marquer résolu',
        onSubmit: () => void go(),
      });
    } else void go();
  };

  const reload = () => {
    if (!dirty) return setReloads((n) => n + 1);
    ui.ask({
      title: 'Recharger l’éditeur de fusion',
      message: `Vos choix non enregistrés pour « ${path} » seront perdus : l'éditeur repart des trois versions.`,
      confirm: 'Recharger',
      danger: true,
      onSubmit: () => setReloads((n) => n + 1),
    });
  };

  const requestClose = () => {
    if (!dirty || mode !== 'merge') return onClose();
    ui.ask({
      title: 'Fermer l’éditeur de fusion',
      message: `Vos choix pour « ${path} » ne sont pas enregistrés dans le fichier. Ils restent en brouillon tant qu'Arbor est ouvert.`,
      confirm: 'Fermer',
      checkbox: { label: 'Abandonner le brouillon', initial: false },
      onSubmit: (_v, drop) => {
        if (drop) {
          done.current = true;
          drafts.delete(draftKey);
        }
        onClose();
      },
    });
  };

  // Clavier : Échap ferme (sauf surcouche ouverte, relevée en capture comme dans le diff), Alt+↑/↓ conflit
  // précédent/suivant, Alt+1/2/3 ma version / leur version / les deux pour le conflit courant.
  const keys = useRef({ requestClose, goConflict, choose, current, conflicts, model });
  keys.current = { requestClose, goConflict, choose, current, conflicts, model };
  useEffect(() => {
    let overlayOpen = false;
    const onCapture = (e: KeyboardEvent) => {
      overlayOpen = !!document.querySelector('[data-overlay]');
    };
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen) return;
      const k = keys.current;
      if (e.key === 'Escape') return k.requestClose();
      if (!e.altKey || e.ctrlKey || e.metaKey || !k.model) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        k.goConflict(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      const digit = /^(?:Digit|Numpad)([1-3])$/.exec(e.code)?.[1];
      if (!digit) return;
      e.preventDefault();
      const target = k.current !== null && k.conflicts.includes(k.current) ? k.current : k.conflicts[0];
      if (target !== undefined) k.choose(target, (['mine', 'theirs', 'mine-theirs'] as const)[Number(digit) - 1]);
    };
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (mode === 'fallback') return <>{fallback}</>;

  const head = (extra: React.ReactNode, tag: React.ReactNode) => (
    <header className="diff-head">
      <div className="diff-title">
        <span className="diff-path">{path}</span>
        {tag}
      </div>
      {extra}
      <button className="icon-btn" title="Fermer (Échap)" onClick={requestClose}>
        <Icon.close />
      </button>
    </header>
  );

  if (!versions || mode === null) {
    return (
      <div className="diff merge-editor">
        {head(null, null)}
        <div className="diff-body">
          <div className="empty">{error ?? 'Chargement…'}</div>
        </div>
      </div>
    );
  }

  if (mode === 'deletion') return <DeletionView repo={repo} path={path} versions={versions} head={head} onClose={onClose} />;
  if (!model) return null;

  // Numéros de ligne de départ de chaque bloc, par côté.
  const starts: Record<Side, number>[] = [];
  const counter = { mine: 1, base: 1, theirs: 1 };
  for (const b of model.blocks) {
    starts.push({ ...counter });
    for (const s of ['mine', 'base', 'theirs'] as const) counter[s] += blockSide(b, s).length;
  }
  const conflictNo = (i: number) => conflicts.indexOf(i) + 1;

  return (
    <div className="diff merge-editor">
      {head(
        <>
          <span className="mg-nav">
            <button className="icon-btn" title="Conflit précédent (Alt+↑)" disabled={!conflicts.length} onClick={() => goConflict(-1)}>
              ↑
            </button>
            <button className="icon-btn" title="Conflit suivant (Alt+↓)" disabled={!conflicts.length} onClick={() => goConflict(1)}>
              ↓
            </button>
          </span>
          <button className="btn btn-sm" title="Repartir des trois versions" onClick={reload}>
            Recharger
          </button>
          <button className="btn btn-sm" title="Écrire le résultat dans le fichier (conflits restants avec des marqueurs)" onClick={() => save(false)}>
            Enregistrer
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={remaining > 0}
            title={remaining > 0 ? 'Résolvez d’abord tous les conflits' : 'Écrire le résultat et indexer le fichier'}
            onClick={() => save(true)}
          >
            Enregistrer et marquer résolu
          </button>
        </>,
        <>
          <span className={`diff-context ${remaining ? 'conflict-tag' : 'mg-ok'}`}>
            {remaining ? `${remaining} conflit${remaining > 1 ? 's' : ''} restant${remaining > 1 ? 's' : ''}` : conflicts.length ? 'Tous les conflits sont résolus' : 'Aucun conflit de contenu'}
          </span>
          {dirty && <span className="diff-context">modifié</span>}
        </>,
      )}
      <div className="mg-panes">
        <div className="mg-top" ref={top} onScroll={() => sync('top')}>
          <div className="mg-grid">
            <div className="mg-colhead mg-ours-head">Ma version</div>
            <div className="mg-colhead">Base (ancêtre commun)</div>
            <div className="mg-colhead mg-theirs-head">Leur version</div>
            {model.blocks.map((b, i) =>
              (['mine', 'base', 'theirs'] as const).map((side) => (
                <div
                  key={`${i}-${side}`}
                  ref={side === 'mine' ? (el) => (el ? rows.current.set(i, el) : rows.current.delete(i)) : undefined}
                  className={`mg-cell ${cellTone(b, side)}${current === i ? ' mg-current' : ''}${b.kind === 'conflict' ? ' mg-conflict-cell' : ''}`}
                  onClick={() => {
                    if (b.kind === 'same') return;
                    setCurrent(i);
                    reveal(i);
                  }}
                >
                  <Lines
                    lines={blockSide(b, side)}
                    start={starts[i][side]}
                    collapsed={b.kind === 'same' && b.lines.length > COLLAPSE_AT && !expanded.has(i)}
                    onExpand={() => setExpanded(new Set(expanded).add(i))}
                  />
                </div>
              )),
            )}
          </div>
        </div>
        <div className="mg-result-head">
          <span>Résultat</span>
          <span className="mg-hint">Chaque bloc est modifiable. Alt+↑/↓ : conflit précédent/suivant ; Alt+1, 2, 3 : ma version, leur version, les deux.</span>
        </div>
        <div className="mg-bottom" ref={bottom} onScroll={() => sync('bottom')}>
          {model.blocks.map((b, i) => {
            const choice = choices.get(i);
            const lines = resolveBlock(b, choice);
            const custom = typeof choice === 'object';
            const state = b.kind === 'conflict' ? (lines ? 'mg-seg-resolved' : 'mg-seg-open') : b.kind === 'same' ? '' : `mg-seg-${b.kind}`;
            return (
              <div key={i} ref={(el) => (el ? segs.current.set(i, el) : segs.current.delete(i))} className={`mg-seg ${state}${current === i ? ' mg-current' : ''}`}>
                {b.kind !== 'same' && (
                  <div className="mg-seg-bar">
                    <span className="mg-seg-label">
                      {b.kind === 'conflict' ? `Conflit ${conflictNo(i)}/${conflicts.length}` : KIND_LABEL[b.kind]}
                      {custom && ' · modifié à la main'}
                    </span>
                    {CHOICES.map((c) => (
                      <button
                        key={String(c.choice)}
                        type="button"
                        className={`btn btn-sm mg-choice${choice === c.choice ? ' on' : ''}`}
                        title={c.key ? `${c.title} (${c.key})` : c.title}
                        onClick={() => choose(i, c.choice)}
                      >
                        {c.label}
                      </button>
                    ))}
                    {choice !== undefined && (
                      <button type="button" className="link-btn" onClick={() => choose(i, null)}>
                        {b.kind === 'conflict' ? 'Annuler le choix' : 'Rétablir'}
                      </button>
                    )}
                  </div>
                )}
                <SegmentText
                  value={lines ? lines.join('\n') : ''}
                  width={width}
                  placeholder={lines ? '(aucune ligne)' : 'Conflit non résolu : choisissez une version ci-dessus ou saisissez le résultat ici.'}
                  onFocus={() => b.kind !== 'same' && setCurrent(i)}
                  onChange={(v) => edit(i, v)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Lines({ lines, start, collapsed, onExpand }: { lines: string[]; start: number; collapsed: boolean; onExpand: () => void }) {
  const row = (l: string, k: number) => (
    <div className="mg-line" key={k}>
      <span className="mg-no">{start + k}</span>
      <span className="mg-txt">{l}</span>
    </div>
  );
  if (!collapsed) return <>{lines.map(row)}</>;
  const hidden = lines.length - 2 * COLLAPSE_KEEP;
  return (
    <>
      {lines.slice(0, COLLAPSE_KEEP).map(row)}
      <button type="button" className="mg-fold" onClick={onExpand}>
        ⋯ {hidden} lignes identiques
      </button>
      {lines.slice(-COLLAPSE_KEEP).map((l, k) => row(l, lines.length - COLLAPSE_KEEP + k))}
    </>
  );
}

/** Zone de texte d'un segment du résultat, à hauteur automatique (pas de défilement interne). */
function SegmentText({ value, width, placeholder, onFocus, onChange }: { value: string; width: number; placeholder: string; onFocus: () => void; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, width]);
  return (
    <textarea
      ref={ref}
      className="mg-text"
      value={value}
      rows={1}
      spellCheck={false}
      placeholder={placeholder}
      onFocus={onFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Conflit suppression/modification : garder le fichier tel qu'il est dans l'arbre de travail, ou le supprimer. */
function DeletionView({
  repo,
  path,
  versions,
  head,
  onClose,
}: {
  repo: string;
  path: string;
  versions: ConflictVersions;
  head: (extra: React.ReactNode, tag: React.ReactNode) => React.ReactNode;
  onClose: () => void;
}) {
  const ui = useUi();
  const survivor = versions.mine !== null ? 'mine' : versions.theirs !== null ? 'theirs' : null;
  const text = survivor ? versions[survivor] ?? '' : '';
  const tag = survivor === 'mine' ? 'supprimé dans leur version' : survivor === 'theirs' ? 'supprimé dans ma version' : 'supprimé des deux côtés';
  const exists = versions.workingHash !== null;
  const preview = !versions.binary && !versions.tooLarge && exists ? splitLines(text).lines : null;

  const keep = async () => {
    if (await ui.run('Résolution…', () => api.resolveDeletion(repo, path, true), `« ${path} » est gardé.`)) onClose();
  };
  const remove = () =>
    ui.ask({
      title: 'Supprimer le fichier',
      message:
        survivor === 'mine'
          ? `Votre version de « ${path} » (modifiée) sera supprimée de l'arbre de travail.`
          : survivor === 'theirs'
            ? `Leur version de « ${path} » (modifiée) sera supprimée de l'arbre de travail.`
            : `« ${path} » sera retiré de l'index.`,
      confirm: 'Supprimer le fichier',
      danger: true,
      onSubmit: async () => {
        if (await ui.run('Résolution…', () => api.resolveDeletion(repo, path, false), `« ${path} » est supprimé.`)) onClose();
      },
    });

  return (
    <div className="diff merge-editor">
      {head(
        <>
          <button className="btn btn-sm" disabled={!exists} title={exists ? 'Garder le fichier tel qu’il est dans l’arbre de travail' : 'Le fichier n’existe plus'} onClick={keep}>
            Garder le fichier
          </button>
          <button className="btn btn-sm patch-discard" onClick={remove}>
            Supprimer le fichier…
          </button>
        </>,
        <span className="diff-context conflict-tag">{tag}</span>,
      )}
      <div className="diff-body">
        <p className="mg-deletion-msg">
          {survivor === 'mine'
            ? 'Vous avez modifié ce fichier, et il a été supprimé dans la version que vous fusionnez.'
            : survivor === 'theirs'
              ? 'Ce fichier a été supprimé de votre côté, et modifié dans la version que vous fusionnez.'
              : 'Ce fichier a été supprimé des deux côtés.'}{' '}
          Gardez-le (la version modifiée, ci-dessous, telle qu’elle est dans l’arbre de travail) ou supprimez-le.
        </p>
        {preview ? (
          <table className="code">
            <tbody>
              {preview.map((l, i) => (
                <tr key={i} className={survivor === 'mine' ? 'cf-ours' : 'cf-theirs'}>
                  <td className="no">{i + 1}</td>
                  <td className="txt">{l}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">{exists ? 'Aperçu indisponible (fichier binaire ou trop gros).' : 'Le fichier n’existe plus dans l’arbre de travail.'}</div>
        )}
      </div>
    </div>
  );
}
