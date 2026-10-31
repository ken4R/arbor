import { useEffect, useMemo, useRef, useState } from 'react';
import type { Commit, RepoSnapshot } from '../../shared/types';
import type { GraphRow } from '../graph';
import type { Selection } from '../App';
import { branchMenu, checkoutBranch, commitMenu } from '../actions';
import { useUi } from '../ui';
import { fullDate, hashColor, initials, laneColor, relativeDate } from '../util';

const ROW_H = 30;
const LANE_W = 16;
const OVERSCAN = 12;

const x = (col: number) => LANE_W / 2 + col * LANE_W + 6;

interface Props {
  snap: RepoSnapshot;
  rows: GraphRow[];
  selection: Selection;
  onSelect: (s: Selection) => void;
}

export function GraphView({ snap, rows, selection, onSelect }: Props) {
  const ui = useUi();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  const st = snap.status;
  const changeCount = st.staged.length + st.unstaged.length + st.conflicted.length;
  const showWip = changeCount > 0 || snap.commits.length === 0;
  const offset = showWip ? 1 : 0;
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

  const selectedIndex = selection.kind === 'wip' ? (showWip ? 0 : -1) : snap.commits.findIndex((c) => c.sha === selection.sha) + offset;

  // Fait défiler jusqu'à la ligne sélectionnée si elle est hors de vue.
  useEffect(() => {
    const el = scroller.current;
    if (!el || selectedIndex < 0) return;
    const top = selectedIndex * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [selectedIndex]);

  const selectIndex = (i: number) => {
    if (i < 0 || i >= total) return;
    if (showWip && i === 0) onSelect({ kind: 'wip' });
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
      <div className="graph-header" style={{ gridTemplateColumns: `${graphCol}px 1fr 160px 120px` }}>
        <span>Graphe</span>
        <span>Message</span>
        <span>Auteur</span>
        <span>Date</span>
      </div>
      <div className="graph-scroll" ref={scroller} tabIndex={0} onKeyDown={onKey} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          {visible.map((i) => {
            const style = { top: i * ROW_H, gridTemplateColumns: `${graphCol}px 1fr 160px 120px` };
            const selected = i === selectedIndex;
            if (showWip && i === 0) {
              return (
                <div key="wip" className={`row wip-row${selected ? ' selected' : ''}`} style={style} onClick={() => onSelect({ kind: 'wip' })}>
                  <svg className="row-graph" width={graphCol} height={ROW_H}>
                    {headIndex === 0 && <line x1={x(wipCol)} y1={ROW_H / 2} x2={x(wipCol)} y2={ROW_H} stroke={laneColor(rows[0].color)} strokeWidth={2} strokeDasharray="3 3" />}
                    <circle cx={x(wipCol)} cy={ROW_H / 2} r={6} fill="var(--bg)" stroke="var(--text-dim)" strokeWidth={2} strokeDasharray="3 2" />
                  </svg>
                  <span className="row-msg">
                    <span className="wip-label">{snap.commits.length === 0 ? 'Premier commit' : 'Modifications en cours'}</span>
                    <span className="wip-count">{changeCount} fichier{changeCount > 1 ? 's' : ''}</span>
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
                className={`row${selected ? ' selected' : ''}${c.sha === snap.head ? ' head' : ''}`}
                style={style}
                onClick={() => onSelect({ kind: 'commit', sha: c.sha })}
                onContextMenu={(e) => ui.openMenu(e, commitMenu(ui, snap, c))}
              >
                <RowGraph row={row} width={graphCol} commit={c} dashedTop={showWip && idx === 0 && headIndex === 0} />
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
            onContextMenu={(e) => r.type !== 'tag' && ui.openMenu(e, branchMenu(ui, snap, r.name, r.type === 'remote'))}
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
