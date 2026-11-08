import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { blockSide, composeResult, isMarkerLine, resolveBlock, splitLines, type Choice, type MergeBlock } from '../../shared/merge3';
import type { ConflictVersions, MergeModel } from '../../shared/types';
import { api } from '../api';
import { setActiveMergeEditor } from '../commands/conflicts';
import { useUi } from '../ui';
import { Icon } from './Icons';

// Éditeur de fusion à trois panneaux : ma version | base | leur version en haut (alignées bloc par bloc, un seul
// défilement), résultat en bas avec un segment éditable par bloc. Les blocs viennent de `git merge-file --diff3`,
// calculé par le processus principal ; les zones sans conflit sont appliquées d'office. Le résultat n'est écrit qu'à
// l'enregistrement ; le main refuse si le fichier a changé depuis le chargement.

type Side = 'mine' | 'base' | 'theirs';

/** Brouillon par fichier (`repo\0chemin`), en mémoire tant qu'Arbor est ouvert : survit au changement d'onglet ou de fichier. */
interface Draft {
  /** Empreinte des trois versions : un brouillon ne s'applique qu'aux mêmes versions. */
  source: string;
  choices: [number, Choice][];
  /** Empreinte attendue du fichier de l'arbre de travail à l'enregistrement. */
  hash: string | null;
  /** Choix non enregistrés. Un brouillon enregistré n'est repris que si le fichier n'a pas changé depuis. */
  dirty: boolean;
  /** Remplacer le fichier actuel est accepté (il différait de la fusion de Git, ou Arbor l'a déjà écrit). */
  overwriteOk: boolean;
}
const drafts = new Map<string, Draft>();

/** Empreinte rapide (FNV-1a 32 bits) des trois versions. */
function sourceKey(v: ConflictVersions): string {
  let h = 0x811c9dc5;
  const text = `${v.base ?? '\u0001'}\u0000${v.mine ?? '\u0001'}\u0000${v.theirs ?? '\u0001'}`;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(h >>> 0).toString(16)}`;
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
  merged: 'Changements des deux côtés, fusionnés par Git',
  conflict: 'Conflit',
};

/** Classe de teinte d'une cellule des panneaux du haut. */
function cellTone(b: MergeBlock, side: Side): string {
  if (b.kind === 'same') return '';
  if (side === 'base') return 'mg-base';
  if (b.kind === 'both') return 'mg-both';
  if (b.kind === 'conflict' || b.kind === 'merged') return side === 'mine' ? 'mg-ours' : 'mg-theirs';
  return b.kind === side ? (side === 'mine' ? 'mg-ours' : 'mg-theirs') : '';
}

const COLLAPSE_AT = 8; // bloc identique plus long : replié dans les panneaux du haut
const COLLAPSE_KEEP = 3;
const SIDES = ['mine', 'base', 'theirs'] as const;

type View = 'editor' | 'warn' | 'fallback';

export function MergeEditor({
  repo,
  path,
  onClose,
  fallback,
  reloadKey,
}: {
  repo: string;
  path: string;
  onClose: () => void;
  fallback: React.ReactNode;
  /** Nouvelle valeur à chaque instantané du dépôt : déclenche la vérification des étages. */
  reloadKey?: unknown;
}) {
  const ui = useUi();
  const draftKey = `${repo}\0${path}`;
  const [versions, setVersions] = useState<ConflictVersions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [view, setView] = useState<View>('editor');
  const [choices, setChoices] = useState<Map<number, Choice>>(() => new Map());
  const [hash, setHash] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [overwriteOk, setOverwriteOk] = useState(true);
  const [current, setCurrent] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  const segs = useRef(new Map<number, HTMLElement>());
  const done = useRef(false); // fichier résolu ou brouillon abandonné : ne plus écrire de brouillon

  const [stale, setStale] = useState(false); // étages changés alors qu'il y a des choix non enregistrés

  // Chargement (et « Recharger », qui abandonne le brouillon). L'ancien contenu reste affiché pendant un rechargement
  // (pas de clignotement). Un changement extérieur du fichier est détecté à l'enregistrement par l'empreinte.
  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .conflictVersions(repo, path)
      .then((v) => {
        if (!alive) return;
        if (reloads > 0) drafts.delete(draftKey);
        const d = drafts.get(draftKey);
        const reuse = d && d.source === sourceKey(v) && (d.dirty || d.hash === v.workingHash) ? d : null;
        setChoices(new Map(reuse?.choices ?? []));
        setHash(reuse ? reuse.hash : v.workingHash);
        setDirty(reuse?.dirty ?? false);
        // Fichier différent de la fusion de Git (résolution commencée ailleurs, rerere…) : l'utilisateur choisit d'abord.
        const ok = reuse ? reuse.overwriteOk : v.workingMatches;
        setOverwriteOk(ok);
        setView(ok || !v.merge ? 'editor' : 'warn');
        setExpanded(new Set());
        setStale(false);
        setVersions(v);
      })
      .catch((e) => {
        if (!alive) return;
        setVersions(null);
        setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [repo, path, reloads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Après chaque rafraîchissement : les étages ont-ils changé (« Passer », étape suivante d'un rebase en conflit sur
  // le même fichier…) ? Vérification légère (`ls-files -u`) : ni relecture ni nouvelle fusion si rien n'a changé.
  // Sans choix en attente, rechargement direct ; sinon, bandeau avec « Recharger ».
  const loaded = useRef<{ stages: string | null; dirty: boolean }>({ stages: null, dirty: false });
  loaded.current = { stages: versions?.stages ?? null, dirty };
  useEffect(() => {
    if (reloadKey === undefined) return;
    let alive = true;
    api
      .conflictStages(repo, path)
      .then((s) => {
        const { stages, dirty: unsaved } = loaded.current;
        if (!alive || s === null || stages === null || s === stages) return; // plus en conflit : l'application ferme la vue
        if (unsaved) setStale(true);
        else setReloads((n) => n + 1);
      })
      .catch(() => {}); // vérification au mieux : l'enregistrement revérifie
    return () => {
      alive = false;
    };
  }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const mode = !versions
    ? null
    : versions.unsupported
      ? 'fallback'
      : versions.mine === null || versions.theirs === null
        ? 'deletion'
        : versions.binary || versions.tooLarge || !versions.merge
          ? 'fallback'
          : 'merge';
  const model: MergeModel | null = mode === 'merge' ? versions!.merge : null;
  const blocks = model?.blocks;
  const conflicts = useMemo(() => (blocks ? blocks.flatMap((b, i) => (b.kind === 'conflict' ? [i] : [])) : []), [blocks]);
  /** Numéro (1…n) de chaque conflit, par index de bloc. */
  const conflictNo = useMemo(() => new Map(conflicts.map((i, k) => [i, k + 1])), [conflicts]);
  const remaining = conflicts.reduce((n, i) => n + (choices.has(i) ? 0 : 1), 0);
  // Numéros de ligne de départ de chaque bloc, par côté.
  const starts = useMemo(() => {
    const out: Record<Side, number>[] = [];
    const counter = { mine: 1, base: 1, theirs: 1 };
    for (const b of blocks ?? []) {
      out.push({ ...counter });
      for (const s of SIDES) counter[s] += blockSide(b, s).length;
    }
    return out;
  }, [blocks]);

  // Brouillon à jour à chaque changement.
  useEffect(() => {
    if (!versions || !model || done.current) return;
    drafts.set(draftKey, { source: sourceKey(versions), choices: [...choices], hash, dirty, overwriteOk });
  }, [versions, model, choices, hash, dirty, overwriteOk, draftKey]);

  // Défilement synchronisé haut/bas, bloc par bloc (position relative dans le bloc visible en haut de chaque panneau).
  const lock = useRef({ top: 0, bottom: 0 });
  const headHeight = () => (top.current?.querySelector('.mg-colhead') as HTMLElement | null)?.offsetHeight ?? 0;
  const sync = (from: 'top' | 'bottom') => {
    const src = from === 'top' ? top.current : bottom.current;
    const dst = from === 'top' ? bottom.current : top.current;
    if (!src || !dst || !blocks || performance.now() < lock.current[from]) return;
    const [srcEls, dstEls] = from === 'top' ? [rows.current, segs.current] : [segs.current, rows.current];
    const y = src.scrollTop + (from === 'top' ? headHeight() : 0);
    // Recherche dichotomique du dernier bloc qui commence avant y.
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((srcEls.get(mid)?.offsetTop ?? Infinity) <= y) lo = mid;
      else hi = mid - 1;
    }
    const s = srcEls.get(lo);
    const d = dstEls.get(lo);
    if (!s || !d) return;
    const frac = s.offsetHeight ? Math.min(1, Math.max(0, (y - s.offsetTop) / s.offsetHeight)) : 0;
    lock.current[from === 'top' ? 'bottom' : 'top'] = performance.now() + 120;
    dst.scrollTop = d.offsetTop + frac * d.offsetHeight - (from === 'top' ? 0 : headHeight());
  };
  /** Amène un bloc en vue dans les deux panneaux. */
  const reveal = useCallback((i: number) => {
    const r = rows.current.get(i);
    const s = segs.current.get(i);
    const until = performance.now() + 150;
    lock.current = { top: until, bottom: until };
    const head = (top.current?.querySelector('.mg-colhead') as HTMLElement | null)?.offsetHeight ?? 0;
    if (r && top.current) top.current.scrollTop = r.offsetTop - head - 24;
    if (s && bottom.current) bottom.current.scrollTop = s.offsetTop - 24;
  }, []);

  // Premier conflit sélectionné et affiché à l'ouverture de l'éditeur.
  useLayoutEffect(() => {
    if (!model || view !== 'editor') return;
    const first = conflicts.find((i) => !choices.has(i)) ?? conflicts[0] ?? null;
    setCurrent(first);
    if (first !== null) requestAnimationFrame(() => reveal(first));
  }, [model, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = useCallback((i: number, c: Choice | null) => {
    setChoices((prev) => {
      const next = new Map(prev);
      if (c === null) next.delete(i);
      else next.set(i, c);
      return next;
    });
    setDirty(true);
    setCurrent(i);
  }, []);
  const edit = useCallback((i: number, value: string) => choose(i, { custom: value === '' ? [] : value.split('\n') }), [choose]);
  const focusBlock = useCallback((i: number) => setCurrent(i), []);
  const selectBlock = useCallback(
    (i: number) => {
      setCurrent(i);
      reveal(i);
    },
    [reveal],
  );
  const expand = useCallback((i: number) => setExpanded((prev) => new Set(prev).add(i)), []);
  const registerRow = useCallback((i: number, el: HTMLElement | null) => (el ? rows.current.set(i, el) : rows.current.delete(i)), []);
  const registerSeg = useCallback((i: number, el: HTMLElement | null) => (el ? segs.current.set(i, el) : segs.current.delete(i)), []);

  const goConflict = (dir: 1 | -1) => {
    if (!conflicts.length) return;
    const pos = current ?? -1;
    const next = dir > 0 ? (conflicts.find((i) => i > pos) ?? conflicts[0]) : ([...conflicts].reverse().find((i) => i < (current ?? Infinity)) ?? conflicts[conflicts.length - 1]);
    selectBlock(next);
  };

  /** Choix au clavier ou par la palette : seulement sur le conflit courant ; sinon, amène au prochain conflit. */
  const chooseCurrent = (c: 'mine' | 'theirs' | 'mine-theirs') => {
    if (current !== null && conflictNo.has(current)) return choose(current, c);
    const target = conflicts.find((i) => i > (current ?? -1) && !choices.has(i)) ?? conflicts.find((i) => !choices.has(i)) ?? conflicts[0];
    if (target !== undefined) selectBlock(target);
  };

  const save = (mark: boolean) => {
    if (!model || view !== 'editor' || (mark && remaining > 0)) return;
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
        setOverwriteOk(true);
      }
    };
    const checkMarkers = () => {
      const suspicious = [...choices.values()].some((c) => typeof c === 'object' && c.custom.some(isMarkerLine));
      if (!mark || !suspicious) return void go();
      ui.ask({
        title: 'Marqueurs de conflit dans le résultat',
        message: 'Un texte saisi contient encore une ligne qui ressemble à un marqueur de conflit (<<<<<<<, =======, >>>>>>>). Marquer le fichier comme résolu quand même ?',
        confirm: 'Marquer résolu',
        onSubmit: () => void go(),
      });
    };
    if (overwriteOk) return checkMarkers();
    ui.ask({
      title: 'Remplacer le fichier actuel',
      message: `« ${path} » ne correspond plus à la fusion de Git (résolution commencée ailleurs, éditeur externe, rerere…). L'enregistrer le remplace par le résultat de l'éditeur : ce qui y a été fait hors de l'éditeur sera perdu.`,
      confirm: 'Remplacer le fichier',
      danger: true,
      onSubmit: checkMarkers,
    });
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
    if (!dirty || mode !== 'merge' || view !== 'editor') return onClose();
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

  // Interface publiée pour la palette et les raccourcis Alt+… (`commands/conflicts.ts`), toujours à jour.
  const latest = useRef({ goConflict, chooseCurrent, save, requestClose, hasConflicts: false, onConflict: false, canMark: false });
  latest.current = {
    goConflict,
    chooseCurrent,
    save,
    requestClose,
    hasConflicts: view === 'editor' && conflicts.length > 0,
    onConflict: current !== null && conflictNo.has(current),
    canMark: view === 'editor' && !!model && remaining === 0,
  };
  const editorOpen = mode === 'merge' && view === 'editor';
  useEffect(() => {
    if (!editorOpen) return;
    setActiveMergeEditor({
      get hasConflicts() {
        return latest.current.hasConflicts;
      },
      get onConflict() {
        return latest.current.onConflict;
      },
      get canMark() {
        return latest.current.canMark;
      },
      next: () => latest.current.goConflict(1),
      previous: () => latest.current.goConflict(-1),
      choose: (c) => latest.current.chooseCurrent(c),
      save: (mark) => latest.current.save(mark),
    });
    return () => setActiveMergeEditor(null);
  }, [editorOpen]);

  // Échap ferme (sauf surcouche ouverte, relevée en capture comme dans le diff).
  useEffect(() => {
    let overlayOpen = false;
    const onCapture = () => {
      overlayOpen = !!document.querySelector('[data-overlay]');
    };
    const onKey = (e: KeyboardEvent) => !overlayOpen && e.key === 'Escape' && latest.current.requestClose();
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (mode === 'fallback' || view === 'fallback') return <>{fallback}</>;

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
  if (!model || !blocks) return null;

  if (view === 'warn') {
    return (
      <div className="diff merge-editor">
        {head(null, <span className="diff-context conflict-tag">déjà modifié</span>)}
        <div className="diff-body">
          <div className="mg-warn">
            <p>
              « {path} » ne correspond plus à la fusion calculée par Git : une résolution a peut-être été commencée (enregistrée puis Arbor relancé,
              éditeur externe, rerere…).
            </p>
            <div className="mg-warn-actions">
              <button className="btn btn-sm" onClick={() => setView('fallback')}>
                Repartir du fichier actuel
              </button>
              <button className="btn btn-sm" onClick={() => setView('editor')}>
                Repartir de la fusion de Git
              </button>
            </div>
            <p className="mg-hint">Repartir de la fusion de Git demandera confirmation avant de remplacer le fichier.</p>
          </div>
        </div>
      </div>
    );
  }

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
      {stale && (
        <div className="mg-stale">
          <span>Les versions en conflit ont changé (nouvelle étape de l'opération) : l'éditeur montre encore les anciennes.</span>
          <button className="btn btn-sm" onClick={reload}>
            Recharger
          </button>
        </div>
      )}
      <div className="mg-panes">
        <div className="mg-top" ref={top} onScroll={() => sync('top')}>
          <div className="mg-grid">
            <div className="mg-colhead mg-ours-head">Ma version</div>
            <div className="mg-colhead">Base (ancêtre commun)</div>
            <div className="mg-colhead mg-theirs-head">Leur version</div>
            {blocks.map((b, i) => (
              <BlockRow
                key={i}
                i={i}
                block={b}
                start={starts[i]}
                current={current === i}
                collapsed={b.kind === 'same' && b.lines.length > COLLAPSE_AT && !expanded.has(i)}
                register={registerRow}
                onSelect={selectBlock}
                onExpand={expand}
              />
            ))}
          </div>
        </div>
        <div className="mg-result-head">
          <span>Résultat</span>
          <span className="mg-hint">Chaque bloc est modifiable. Alt+↑/↓ : conflit précédent/suivant ; Alt+1, 2, 3 : ma version, leur version, les deux.</span>
        </div>
        <div className="mg-bottom" ref={bottom} onScroll={() => sync('bottom')}>
          {blocks.map((b, i) => (
            <Segment
              key={i}
              i={i}
              block={b}
              choice={choices.get(i)}
              current={current === i}
              no={conflictNo.get(i) ?? 0}
              total={conflicts.length}
              register={registerSeg}
              onChoose={choose}
              onEdit={edit}
              onFocus={focusBlock}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Une ligne de la grille du haut : le bloc vu de ma version, de la base et de leur version. */
const BlockRow = memo(function BlockRow({
  i,
  block: b,
  start,
  current,
  collapsed,
  register,
  onSelect,
  onExpand,
}: {
  i: number;
  block: MergeBlock;
  start: Record<Side, number>;
  current: boolean;
  collapsed: boolean;
  register: (i: number, el: HTMLElement | null) => void;
  onSelect: (i: number) => void;
  onExpand: (i: number) => void;
}) {
  return (
    <>
      {SIDES.map((side) => (
        <div
          key={side}
          ref={side === 'mine' ? (el) => register(i, el) : undefined}
          className={`mg-cell ${cellTone(b, side)}${current ? ' mg-current' : ''}${b.kind === 'conflict' ? ' mg-conflict-cell' : ''}`}
          onClick={b.kind === 'same' ? undefined : () => onSelect(i)}
        >
          <Lines lines={blockSide(b, side)} start={start[side]} collapsed={collapsed} onExpand={() => onExpand(i)} />
        </div>
      ))}
    </>
  );
});

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

/** Segment du résultat pour un bloc : barre de choix (bloc modifié) et texte modifiable. */
const Segment = memo(function Segment({
  i,
  block: b,
  choice,
  current,
  no,
  total,
  register,
  onChoose,
  onEdit,
  onFocus,
}: {
  i: number;
  block: MergeBlock;
  choice: Choice | undefined;
  current: boolean;
  no: number;
  total: number;
  register: (i: number, el: HTMLElement | null) => void;
  onChoose: (i: number, c: Choice | null) => void;
  onEdit: (i: number, v: string) => void;
  onFocus: (i: number) => void;
}) {
  const lines = resolveBlock(b, choice);
  const custom = typeof choice === 'object';
  const state = b.kind === 'conflict' ? (lines ? 'mg-seg-resolved' : 'mg-seg-open') : b.kind === 'same' ? '' : `mg-seg-${b.kind}`;
  return (
    <div ref={(el) => register(i, el)} className={`mg-seg ${state}${current ? ' mg-current' : ''}`}>
      {b.kind !== 'same' && (
        <div className="mg-seg-bar">
          <span className="mg-seg-label">
            {b.kind === 'conflict' ? `Conflit ${no}/${total}` : KIND_LABEL[b.kind]}
            {custom && ' · modifié à la main'}
          </span>
          {CHOICES.map((c) => (
            <button
              key={String(c.choice)}
              type="button"
              className={`btn btn-sm mg-choice${choice === c.choice ? ' on' : ''}`}
              title={c.key ? `${c.title} (${c.key})` : c.title}
              onClick={() => onChoose(i, c.choice)}
            >
              {c.label}
            </button>
          ))}
          {choice !== undefined && (
            <button type="button" className="link-btn" onClick={() => onChoose(i, null)}>
              {b.kind === 'conflict' ? 'Annuler le choix' : 'Rétablir'}
            </button>
          )}
        </div>
      )}
      {/* Hauteur automatique par `field-sizing: content` (CSS) : aucune mesure en JavaScript. */}
      <textarea
        className="mg-text"
        value={lines ? lines.join('\n') : ''}
        rows={1}
        spellCheck={false}
        placeholder={lines ? '(aucune ligne)' : 'Conflit non résolu : choisissez une version ci-dessus ou saisissez le résultat ici.'}
        onFocus={() => onFocus(i)}
        onChange={(e) => onEdit(i, e.target.value)}
      />
    </div>
  );
});

/**
 * Conflit suppression/modification : garder le fichier tel qu'il est dans l'arbre de travail, ou le supprimer.
 * L'aperçu montre le fichier réel (modifications locales comprises), puisque c'est lui que `git rm` efface.
 */
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
  const tag = survivor === 'mine' ? 'supprimé dans leur version' : survivor === 'theirs' ? 'supprimé dans ma version' : 'supprimé des deux côtés';
  const exists = versions.workingHash !== null;
  const [working, setWorking] = useState<string[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!exists || versions.binary || versions.tooLarge) return;
    api
      .readFile(repo, path)
      .then((t) => alive && setWorking(splitLines(t).lines))
      .catch((e) => alive && setReadError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, path, exists, versions.binary, versions.tooLarge]);

  const keep = async () => {
    if (await ui.run('Résolution…', () => api.resolveDeletion(repo, path, true), `« ${path} » est gardé.`)) onClose();
  };
  const remove = () =>
    ui.ask({
      title: 'Supprimer le fichier',
      message: exists
        ? `« ${path} » sera supprimé de l'arbre de travail tel qu'il est (contenu affiché, modifications locales comprises).`
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
          Gardez-le tel qu'il est dans l'arbre de travail (ci-dessous) ou supprimez-le.
        </p>
        {working ? (
          <table className="code">
            <tbody>
              {working.map((l, i) => (
                <tr key={i} className={survivor === 'mine' ? 'cf-ours' : 'cf-theirs'}>
                  <td className="no">{i + 1}</td>
                  <td className="txt">{l}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            {!exists ? 'Le fichier n’existe plus dans l’arbre de travail.' : versions.binary || versions.tooLarge ? 'Aperçu indisponible (fichier binaire ou trop gros).' : (readError ?? 'Chargement…')}
          </div>
        )}
      </div>
    </div>
  );
}
