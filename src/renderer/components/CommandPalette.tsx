import { useEffect, useMemo, useRef, useState } from 'react';
import { formatShortcut, getCommandContext, getCommands, matchShortcut, useCommandContext, type Command } from '../commands';
import { GROUP_BRANCHES, GROUP_FILES, GROUP_TAGS, loadRecentRepos } from '../commands/git';
import { makeEntry, searchEntries, type PaletteEntry, type PaletteKind, type PaletteResult } from '../paletteSearch';

// Palette de commandes : Ctrl/Cmd+Maj+P ou Ctrl/Cmd+K. Recherche floue sur les commandes du registre
// (dont branches, tags, dépôts récents et fichiers modifiés). Préfixes : `>` commandes, `@` branches et tags,
// `#` fichiers modifiés.

const SHORTCUTS = ['Mod+Shift+P', 'Mod+K'];
const HISTORY_MAX = 20;

const kindOf = (cmd: Command): PaletteKind =>
  cmd.group === GROUP_BRANCHES || cmd.group === GROUP_TAGS ? 'ref' : cmd.group === GROUP_FILES ? 'file' : 'command';

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

const isShortcut = (e: KeyboardEvent) => SHORTCUTS.some((s) => matchShortcut(e, s));

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const set = new Set(indices);
  let last = 0;
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
  const inputRef = useRef<HTMLInputElement>(null);

  // Ouverture : écouteur permanent (phase de bouillonnement), inactif quand la palette est ouverte (l'écouteur de
  // capture ci-dessous prend alors le relais) ou quand une autre surcouche l'est déjà.
  useEffect(() => {
    if (open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !isShortcut(e)) return;
      if (document.querySelector('[data-overlay]')) return;
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
      setActive(0);
      setOpen(true);
      void loadRecentRepos().then(() => setRecentsVersion((v) => v + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Textes normalisés calculés une fois par contexte (instantané) et non à chaque frappe.
  const entries = useMemo<PaletteEntry<Command>[]>(() => {
    if (!open) return [];
    return getCommands(ctx).map((cmd) =>
      makeEntry(cmd, kindOf(cmd), cmd.title, [cmd.group, ...(cmd.keywords ?? [])].join(' '), historyBoost(cmd.id)),
    );
  }, [open, ctx, recentsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => searchEntries(entries, query), [entries, query]);
  const current = Math.min(active, Math.max(results.length - 1, 0));

  const close = () => setOpen(false);
  const runResult = (r: PaletteResult<Command> | undefined) => {
    if (!r) return;
    close();
    remember(r.entry.item.id);
    r.entry.item.run(getCommandContext());
  };

  // Clavier pendant que la palette est ouverte : écouteur de capture sur window, avant tout autre écouteur
  // (recherche Ctrl+F, diff, vue fichier…). Il gère Échap, ↑/↓, Entrée et le raccourci (qui referme), et retient
  // les autres raccourcis Mod+… (sans empêcher leur effet natif dans le champ : copier, coller, tout sélectionner).
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (isShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) close();
      return;
    }
    switch (e.key) {
      case 'Escape':
        // Ne ferme que la palette (pas le diff ni la vue fichier en dessous).
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        e.stopPropagation();
        const n = results.length;
        if (n) setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
        return;
      }
      case 'Enter':
        // Validation d'une composition (IME) : ce n'est pas une exécution.
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        runResult(results[current]);
        return;
    }
    if (e.ctrlKey || e.metaKey) e.stopPropagation();
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [current, results]);

  if (!open) return null;

  return (
    <div className="overlay palette-overlay" data-overlay onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-label="Palette de commandes"
        onMouseDown={(e) => {
          e.stopPropagation();
          // Le champ garde le focus (et donc le clavier) quel que soit l'endroit cliqué dans la palette.
          if (e.target !== inputRef.current) e.preventDefault();
        }}
      >
        <input
          ref={inputRef}
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
              key={r.entry.item.id}
              role="option"
              aria-selected={i === current}
              className={`palette-item${i === current ? ' active' : ''}`}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => runResult(r)}
            >
              <span className="palette-title">
                <Highlight text={r.entry.item.title} indices={r.indices} />
              </span>
              <span className="palette-group">{r.entry.item.group}</span>
              {r.entry.item.shortcut && <kbd className="palette-kbd">{formatShortcut(r.entry.item.shortcut)}</kbd>}
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
