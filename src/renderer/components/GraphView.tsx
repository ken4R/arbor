import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Commit, RepoSnapshot } from '../../shared/types';
import type { GraphRow } from '../graph';
import type { Selection } from '../App';
import { branchMenu, checkoutBranch, commitMenu, tagMenu } from '../actions';
import { useUi } from '../ui';
import { fullDate, hashColor, initials, laneColor, relativeDate } from '../util';
import { isShaQuery, matchNormalized, normalize, normalizeCommit, useSearch } from '../search';
import { SearchBar } from './SearchBar';
import { Icon } from './Icons';
import { anchorFor, reanchor, scrollTopFor } from '../scroll';
import type { ScrollAnchor } from '../../shared/session';

const ROW_H = 30;
const LANE_W = 16;
const OVERSCAN = 12;

const x = (col: number) => LANE_W / 2 + col * LANE_W + 6;

interface Props {
  snap: RepoSnapshot;
  rows: GraphRow[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Position de défilement à restaurer au montage (changement d'onglet, fermeture d'un diff, redémarrage). */
  initialAnchor?: ScrollAnchor | null;
  /** Position de défilement courante, au plus une fois par image (et au démontage si elle a changé). */
  onAnchor?: (a: ScrollAnchor) => void;
}

export function GraphView({ snap, rows, selection, onSelect, initialAnchor, onAnchor }: Props) {
  const ui = useUi();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  const st = snap.status;
  const changeCount = st.staged.length + st.unstaged.length + st.conflicted.length;
  // La ligne du répertoire de travail (index 0) reste toujours visible : c'est l'accès au panneau de commit.
  const clean = changeCount === 0 && st.state === 'clean';
  const offset = 1;
  const total = snap.commits.length + offset;

  const headIndex = useMemo(() => snap.commits.findIndex((c) => c.sha === snap.head), [snap]);
  const graphWidth = useMemo(() => Math.max(1, ...rows.map((r) => r.width)) * LANE_W + 12, [rows]);
  const graphCol = Math.min(Math.max(graphWidth, 60), 280);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Recherche : texte normalisé mémorisé par instantané, correspondances recalculées à chaque frappe.
  const [search, updateSearch] = useSearch(snap.path);
  const normalized = useMemo(() => snap.commits.map(normalizeCommit), [snap]);
  const searchText = search.text.trim();
  // Rien n'est estompé tant qu'une recherche par fichier n'a renvoyé aucun résultat (attente ou erreur).
  const fileResult = search.field === 'file' && search.file?.text === searchText && search.file.hasResult ? search.file : null;
  const { matches, matchSet, outside } = useMemo(() => {
    if (!search.open || !searchText) return { matches: null, matchSet: null, outside: 0 };
    let list: string[];
    let outside = 0;
    if (search.field === 'file') {
      if (!fileResult) return { matches: null, matchSet: null, outside: 0 };
      const found = new Set(fileResult.shas);
      list = snap.commits.filter((c) => found.has(c.sha)).map((c) => c.sha);
      outside = found.size - list.length;
    } else {
      if (search.field === 'sha' && !isShaQuery(searchText)) return { matches: null, matchSet: null, outside: 0 };
      const q = normalize(searchText);
      list = normalized.filter((n) => matchNormalized(n, search.field, q)).map((n) => n.sha);
    }
    return { matches: list, matchSet: new Set(list), outside };
  }, [search.open, search.field, searchText, fileResult, snap, normalized]);

  const selectedIndex = selection.kind === 'wip' ? 0 : snap.commits.findIndex((c) => c.sha === selection.sha) + offset;

  // état des onglets : position restaurée au montage, avant le premier affichage ; elle l'emporte alors sur
  // « défiler jusqu'à la sélection » (premier passage sauté), y compris si la sélection est hors de vue.
  const anchorRestored = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !initialAnchor) return;
    el.scrollTop = scrollTopFor(snap.commits, initialAnchor, ROW_H);
    setScrollTop(el.scrollTop);
    anchorRestored.current = true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Ancrage remonté au plus une fois par image ; le dernier défilement non transmis l'est au démontage (l'élément
  // n'est alors plus accessible : on garde sa dernière position).
  const anchorFrame = useRef(0);
  const lastScrollTop = useRef(0);
  const anchorSource = useRef({ snap, onAnchor });
  anchorSource.current = { snap, onAnchor };
  const reportAnchor = () => {
    anchorFrame.current = 0;
    const { snap: s, onAnchor: cb } = anchorSource.current;
    cb?.(anchorFor(s.commits, lastScrollTop.current, ROW_H));
  };
  useEffect(
    () => () => {
      if (!anchorFrame.current) return;
      cancelAnimationFrame(anchorFrame.current);
      reportAnchor();
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Commits changés sous la vue (rafraîchissement) : la première ligne visible reste en place.
  const prevCommits = useRef(snap.commits);
  useLayoutEffect(() => {
    const prev = prevCommits.current;
    prevCommits.current = snap.commits;
    const el = scroller.current;
    if (!el || prev === snap.commits) return;
    const next = reanchor(prev, snap.commits, el.scrollTop, ROW_H);
    if (next === el.scrollTop) return;
    el.scrollTop = next;
    setScrollTop(el.scrollTop);
    lastScrollTop.current = el.scrollTop;
  }, [snap.commits]);

  // Fait défiler jusqu'à la ligne sélectionnée si elle est hors de vue.
  useEffect(() => {
    const el = scroller.current;
    if (anchorRestored.current) {
      anchorRestored.current = false;
      return;
    }
    if (!el || selectedIndex < 0) return;
    const top = selectedIndex * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [selectedIndex]);

  const selectIndex = (i: number) => {
    if (i < 0 || i >= total) return;
    if (i === 0) onSelect({ kind: 'wip' });
    else onSelect({ kind: 'commit', sha: snap.commits[i - offset].sha });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') selectIndex(Math.max(selectedIndex, -1) + 1);
    else if (e.key === 'ArrowUp') selectIndex(selectedIndex - 1);
    else return;
    e.preventDefault();
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const visible = [];
  for (let i = first; i < last; i++) visible.push(i);

  const wipCol = headIndex >= 0 ? rows[headIndex].col : 0;

  return (
    <div className="graph">
      <SearchBar
        snap={snap}
        matches={matches ?? []}
        outside={outside}
        selectedSha={selection.kind === 'commit' ? selection.sha : null}
        onSelect={(sha) => onSelect({ kind: 'commit', sha })}
      />
      <div className="graph-header" style={{ gridTemplateColumns: `${graphCol}px 1fr 160px 120px` }}>
        <span>Graphe</span>
        <span>Message</span>
        <span>Auteur</span>
        <span className="graph-header-last">
          Date
          {!search.open && (
            <button className="icon-btn graph-search-btn" title="Rechercher dans l'historique (Ctrl+F)" onClick={() => updateSearch({ open: true })}>
              <Icon.search />
            </button>
          )}
        </span>
      </div>
      <div
        className="graph-scroll"
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          lastScrollTop.current = e.currentTarget.scrollTop;
          if (onAnchor && !anchorFrame.current) anchorFrame.current = requestAnimationFrame(reportAnchor);
        }}
      >
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          {visible.map((i) => {
            const style = { top: i * ROW_H, gridTemplateColumns: `${graphCol}px 1fr 160px 120px` };
            const selected = i === selectedIndex;
            if (i === 0) {
              return (
                <div key="wip" className={`row wip-row${selected ? ' selected' : ''}`} style={style} onClick={() => onSelect({ kind: 'wip' })}>
                  <svg className="row-graph" width={graphCol} height={ROW_H}>
                    {headIndex === 0 && <line x1={x(wipCol)} y1={ROW_H / 2} x2={x(wipCol)} y2={ROW_H} stroke={laneColor(rows[0].color)} strokeWidth={2} strokeDasharray="3 3" />}
                    <circle cx={x(wipCol)} cy={ROW_H / 2} r={6} fill="var(--bg)" stroke="var(--text-dim)" strokeWidth={2} strokeDasharray="3 2" />
                  </svg>
                  <span className="row-msg">
                    <span className="wip-label">{snap.commits.length === 0 ? 'Premier commit' : clean ? 'Répertoire de travail propre' : 'Modifications en cours'}</span>
                    {changeCount > 0 && <span className="wip-count">{changeCount} fichier{changeCount > 1 ? 's' : ''}</span>}
                  </span>
                  <span />
                  <span />
                </div>
              );
            }
            const idx = i - offset;
            const c = snap.commits[idx];
            const row = rows[idx];
            return (
              <div
                key={c.sha}
                className={`row${selected ? ' selected' : ''}${c.sha === snap.head ? ' head' : ''}${matchSet ? (matchSet.has(c.sha) ? ' match' : ' dim') : ''}`}
                style={style}
                onClick={() => onSelect({ kind: 'commit', sha: c.sha })}
                onContextMenu={(e) => ui.openMenu(e, commitMenu(ui, snap, c))}
              >
                <RowGraph row={row} width={graphCol} commit={c} dashedTop={idx === 0 && headIndex === 0} />
                <span className="row-msg">
                  <RefBadges commit={c} snap={snap} color={laneColor(row.color)} />
                  <span className="row-subject">{c.subject}</span>
                </span>
                <span className="row-author">
                  <span className="avatar" style={{ background: hashColor(c.email) }}>
                    {initials(c.author)}
                  </span>
                  {c.author}
                </span>
                <span className="row-date" title={fullDate(c.date)}>
                  {relativeDate(c.date)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function curve(x1: number, y1: number, x2: number, y2: number) {
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

function RowGraph({ row, width, commit, dashedTop }: { row: GraphRow; width: number; commit: Commit; dashedTop: boolean }) {
  const mid = ROW_H / 2;
  const cx = x(row.col);
  const merge = commit.parents.length > 1;
  return (
    <svg className="row-graph" width={width} height={ROW_H}>
      {row.pass.map((e) => (
        <line key={`p${e.col}`} x1={x(e.col)} y1={0} x2={x(e.col)} y2={ROW_H} stroke={laneColor(e.color)} strokeWidth={2} />
      ))}
      {row.incoming.map((e) => (
        <path key={`i${e.col}`} d={curve(x(e.col), 0, cx, mid)} stroke={laneColor(e.color)} strokeWidth={2} fill="none" />
      ))}
      {row.outgoing.map((e, k) => (
        <path key={`o${k}`} d={curve(cx, mid, x(e.col), ROW_H)} stroke={laneColor(e.color)} strokeWidth={2} fill="none" />
      ))}
      {dashedTop && <line x1={cx} y1={0} x2={cx} y2={mid} stroke="var(--text-dim)" strokeWidth={2} strokeDasharray="3 3" />}
      {merge ? (
        <circle cx={cx} cy={mid} r={4.5} fill={laneColor(row.color)} stroke="var(--bg)" strokeWidth={1.5} />
      ) : (
        <circle cx={cx} cy={mid} r={6.5} fill="var(--bg)" stroke={laneColor(row.color)} strokeWidth={2.5} />
      )}
    </svg>
  );
}

function RefBadges({ commit, snap, color }: { commit: Commit; snap: RepoSnapshot; color: string }) {
  const ui = useUi();
  const isHead = commit.refs.some((r) => r.type === 'head');
  const refs = commit.refs.filter((r) => r.type !== 'head');
  if (!refs.length && !isHead) return null;
  const localNames = new Set(refs.filter((r) => r.type === 'local').map((r) => r.name));
  return (
    <span className="refs">
      {isHead && !snap.status.branch && <span className="ref ref-head">HEAD</span>}
      {refs.map((r) => {
        // Une branche distante synchronisée avec la branche locale est fusionnée dans le même badge.
        if (r.type === 'remote' && localNames.has(r.name.split('/').slice(1).join('/'))) return null;
        const synced = r.type === 'local' && refs.some((o) => o.type === 'remote' && o.name.split('/').slice(1).join('/') === r.name);
        const current = r.type === 'local' && r.name === snap.status.branch;
        return (
          <span
            key={r.type + r.name}
            className={`ref ref-${r.type}${current ? ' ref-current' : ''}`}
            style={r.type === 'tag' ? undefined : { borderColor: color, ...(current ? { background: color } : {}) }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (r.type !== 'tag' && !current) checkoutBranch(ui, snap.path, r.name);
            }}
            onContextMenu={(e) => {
              if (r.type !== 'tag') return ui.openMenu(e, branchMenu(ui, snap, r.name, r.type === 'remote'));
              // Tag absent de l'instantané (course avec un rafraîchissement) : le menu du commit s'ouvre.
              const tag = snap.tags.find((t) => t.name === r.name);
              if (tag) ui.openMenu(e, tagMenu(ui, snap, tag));
            }}
            title={r.type === 'remote' ? `Branche distante ${r.name}` : r.type === 'tag' ? `Tag ${r.name}` : synced ? `${r.name} (synchronisée)` : r.name}
          >
            {r.type === 'tag' ? '◆ ' : ''}
            {r.name}
            {synced && <span className="ref-cloud">☁</span>}
          </span>
        );
      })}
    </span>
  );
}
