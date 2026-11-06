import { useEffect, useMemo, useRef, useState } from 'react';
import { formatShortcut, getCommandContext, getCommands, matchShortcut, useCommandContext, type Command } from '../commands';
import { GROUP_BRANCHES, GROUP_FILES, GROUP_TAGS, loadRecentRepos } from '../commands/git';
import { prepareQuery, prepareText, fuzzyMatch, type PreparedText } from '../fuzzy';

// Palette de commandes : Ctrl/Cmd+Maj+P ou Ctrl/Cmd+K. Recherche floue sur les commandes du registre
// (dont branches, tags, dépôts récents et fichiers modifiés). Préfixes : `>` commandes, `@` branches et tags,
// `#` fichiers modifiés.

const SHORTCUTS = ['Mod+Shift+P', 'Mod+K'];
const LIMIT = 50;
const HISTORY_MAX = 20;
/** Les fichiers modifiés n'apparaissent sans préfixe qu'au-delà de cette longueur de requête. */
const FILES_MIN_QUERY = 3;
/** Une correspondance sur les mots-clés seulement passe derrière une correspondance sur le titre. */
const KEYWORD_PENALTY = 10;

type Kind = 'command' | 'ref' | 'file';

const kindOf = (cmd: Command): Kind => (cmd.group === GROUP_BRANCHES || cmd.group === GROUP_TAGS ? 'ref' : cmd.group === GROUP_FILES ? 'file' : 'command');

// Dernières commandes lancées (la plus récente en tête), en mémoire pour la session : départage les scores.
const history: string[] = [];

function remember(id: string) {
  const i = history.indexOf(id);
  if (i >= 0) history.splice(i, 1);
  history.unshift(id);
  history.length = Math.min(history.length, HISTORY_MAX);
}

function historyBoost(id: string): number {
  const i = history.indexOf(id);
  return i < 0 ? 0 : 1 - i / HISTORY_MAX;
}

interface Entry {
  cmd: Command;
  kind: Kind;
  title: PreparedText;
  keywords: PreparedText | null;
}

interface Result {
  entry: Entry;
  score: number;
  indices: number[];
}

function parseQuery(raw: string): { kind: Kind | null; text: string } {
  const c = raw[0];
  if (c === '>') return { kind: 'command', text: raw.slice(1) };
  if (c === '@') return { kind: 'ref', text: raw.slice(1) };
  if (c === '#') return { kind: 'file', text: raw.slice(1) };
  return { kind: null, text: raw };
}

function search(entries: Entry[], raw: string): Result[] {
  const { kind, text } = parseQuery(raw);
  const q = prepareQuery(text);
  const out: (Result & { order: number })[] = [];
  entries.forEach((entry, order) => {
    if (kind ? entry.kind !== kind : entry.kind === 'file' ? q.length < FILES_MIN_QUERY : entry.kind === 'ref' && !q) return;
    let m = fuzzyMatch(q, entry.title);
    if (!m && entry.keywords) {
      const k = fuzzyMatch(q, entry.keywords);
      if (k) m = { score: k.score - KEYWORD_PENALTY, indices: [] };
    }
    if (m) out.push({ entry, score: m.score + historyBoost(entry.cmd.id), indices: m.indices, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.slice(0, LIMIT);
}

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  const set = new Set(indices);
  let i = 0;
  while (i < text.length) {
    if (!set.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && set.has(j)) j++;
    if (i > last) parts.push(text.slice(last, i));
    parts.push(<mark key={i}>{text.slice(i, j)}</mark>);
    last = i = j;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recentsVersion, setRecentsVersion] = useState(0);
  const ctx = useCommandContext();
  const listRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!SHORTCUTS.some((s) => matchShortcut(e, s))) return;
      // Une autre surcouche (dialogue, menu…) est ouverte : on ne l'empile pas.
      if (!openRef.current && document.querySelector('[data-overlay]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (openRef.current) {
        setOpen(false);
        return;
      }
      setQuery('');
      setActive(0);
      setOpen(true);
      void loadRecentRepos().then(() => setRecentsVersion((v) => v + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Textes normalisés calculés une fois par contexte (instantané) et non à chaque frappe.
  const entries = useMemo<Entry[]>(() => {
    if (!open) return [];
    return getCommands(ctx).map((cmd) => ({
      cmd,
      kind: kindOf(cmd),
      title: prepareText(cmd.title),
      keywords: cmd.keywords?.length ? prepareText(`${cmd.group} ${cmd.keywords.join(' ')}`) : prepareText(cmd.group),
    }));
  }, [open, ctx, recentsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => search(entries, query), [entries, query]);
  const current = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [current, results]);

  if (!open) return null;

  const close = () => setOpen(false);
  const runEntry = (r: Result | undefined) => {
    if (!r) return;
    close();
    remember(r.entry.cmd.id);
    r.entry.cmd.run(getCommandContext());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        // Ne ferme que la palette (pas le diff ni la vue fichier en dessous).
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (results.length) setActive((current + 1) % results.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (results.length) setActive((current - 1 + results.length) % results.length);
        break;
      case 'Enter':
        e.preventDefault();
        runEntry(results[current]);
        break;
    }
  };

  return (
    <div className="overlay palette-overlay" data-overlay onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Palette de commandes" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          className="palette-input"
          autoFocus
          value={query}
          placeholder="Rechercher une commande, une branche (@), un fichier modifié (#)…"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette-empty">Aucun résultat</div>}
          {results.map((r, i) => (
            <div
              key={r.entry.cmd.id}
              role="option"
              aria-selected={i === current}
              className={`palette-item${i === current ? ' active' : ''}`}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => runEntry(r)}
            >
              <span className="palette-title">
                <Highlight text={r.entry.cmd.title} indices={r.indices} />
              </span>
              <span className="palette-group">{r.entry.cmd.group}</span>
              {r.entry.cmd.shortcut && <kbd className="palette-kbd">{formatShortcut(r.entry.cmd.shortcut)}</kbd>}
            </div>
          ))}
        </div>
        <div className="palette-hint">
          <span>↑↓ naviguer</span>
          <span>Entrée exécuter</span>
          <span>Échap fermer</span>
          <span className="palette-hint-sep" />
          <span>&gt; commandes</span>
          <span>@ branches</span>
          <span># fichiers</span>
        </div>
      </div>
    </div>
  );
}
