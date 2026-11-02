import { useEffect, useRef } from 'react';
import type { RepoSnapshot } from '../../shared/types';
import { SEARCH_FIELDS, isShaQuery, refsKey, runFileSearch, useSearch } from '../search';
import { Icon } from './Icons';

interface Props {
  snap: RepoSnapshot;
  /** SHA des commits chargés qui correspondent, dans l'ordre du graphe. */
  matches: string[];
  /** Résultats de la recherche par fichier absents des commits chargés. */
  outside: number;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
}

export function SearchBar({ snap, matches, outside, selectedSha, onSelect }: Props) {
  const repo = snap.path;
  const [s, update] = useSearch(repo);
  const input = useRef<HTMLInputElement>(null);
  const key = refsKey(snap);
  const text = s.text.trim();
  const fileMode = s.field === 'file';
  const fileStale = fileMode && text !== '' && s.file?.text !== text;

  // Ctrl/Cmd+F ouvre la recherche, sauf quand la vue d'un fichier (historique, blame) est affichée.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f' || e.shiftKey || e.altKey) return;
      if (document.querySelector('.file-view')) return;
      e.preventDefault();
      update({ open: true });
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [update]);

  // Les refs ont changé (commit, fetch…) : la recherche par fichier est relancée sur le même texte, seulement
  // si elle est affichée ; à la réouverture ou au retour en mode Fichier, l'empreinte mémorisée déclenche la relance.
  useEffect(() => {
    if (!s.open || s.field !== 'file') return;
    if (s.file && s.file.status !== 'pending' && s.file.refsKey !== key) void runFileSearch(repo, s.file.text, key);
  }, [repo, key, s.open, s.field, s.file]);

  if (!s.open) return null;

  const pos = selectedSha ? matches.indexOf(selectedSha) : -1;
  const go = (dir: 1 | -1) => {
    if (!matches.length) return;
    let i: number;
    if (pos >= 0) i = (pos + dir + matches.length) % matches.length;
    else {
      // Depuis un commit qui ne correspond pas : correspondance suivante ou précédente dans l'ordre du graphe.
      const order = new Map(snap.commits.map((c, k) => [c.sha, k]));
      const from = selectedSha ? order.get(selectedSha) ?? -1 : -1;
      const idx = matches.map((m) => order.get(m) ?? 0);
      i = dir === 1 ? idx.findIndex((k) => k > from) : idx.length - 1 - [...idx].reverse().findIndex((k) => k < from);
      if (i < 0 || i >= matches.length) i = dir === 1 ? 0 : matches.length - 1;
    }
    onSelect(matches[i]);
  };

  const submit = (dir: 1 | -1) => {
    if (fileMode && text && (fileStale || s.file?.status === 'error')) void runFileSearch(repo, text, key);
    else go(dir);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit(e.shiftKey ? -1 : 1);
    else if (e.key === 'Escape') {
      if (s.text) update({ text: '' });
      else update({ open: false });
    } else return;
    e.preventDefault();
  };

  let info: string;
  if (!text) info = '';
  else if (fileMode && fileStale) info = 'Entrée pour chercher';
  else if (fileMode && s.file?.status === 'pending') info = 'Recherche…';
  else if (fileMode && s.file?.status === 'error') info = 'Erreur';
  else if (s.field === 'sha' && !isShaQuery(text)) info = '4 caractères hexa min.';
  else if (!matches.length) info = 'Aucun résultat';
  else info = pos >= 0 ? `${pos + 1} / ${matches.length}` : `${matches.length} résultat${matches.length > 1 ? 's' : ''}`;

  const notes: string[] = [];
  if (fileMode && !fileStale && s.file?.status === 'done') {
    if (outside > 0) notes.push(`${outside} résultat${outside > 1 ? 's' : ''} hors des commits chargés`);
    if (s.file.truncated) notes.push('limite de résultats atteinte');
  }
  if (fileMode && !fileStale && s.file?.status === 'error' && s.file.error) notes.push(s.file.error);

  return (
    <div className="search-bar">
      <span className="search-icon">
        <Icon.search />
      </span>
      <input
        ref={input}
        className="search-input"
        value={s.text}
        autoFocus
        spellCheck={false}
        placeholder={fileMode ? 'Chemin de fichier contenant…' : 'Rechercher un message, un auteur, un SHA…'}
        onChange={(e) => update({ text: e.target.value })}
        onKeyDown={onKeyDown}
      />
      <div className="seg">
        {SEARCH_FIELDS.map((f) => (
          <button
            key={f.field}
            className={s.field === f.field ? 'on' : ''}
            onClick={() => {
              update({ field: f.field });
              input.current?.focus();
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <span className={`search-count${text && !matches.length && !fileStale ? ' none' : ''}`}>{info}</span>
      {notes.length > 0 && (
        <span className="search-note" title={notes.join(' · ')}>
          {notes.join(' · ')}
        </span>
      )}
      <button className="icon-btn search-nav" title="Précédent (Maj+Entrée)" disabled={!matches.length} onClick={() => go(-1)}>
        <span className="search-up">
          <Icon.chevron />
        </span>
      </button>
      <button className="icon-btn search-nav" title="Suivant (Entrée)" disabled={!matches.length} onClick={() => go(1)}>
        <span className="search-down">
          <Icon.chevron />
        </span>
      </button>
      <button className="icon-btn" title="Fermer la recherche (Échap)" onClick={() => update({ open: false })}>
        <Icon.close />
      </button>
    </div>
  );
}
