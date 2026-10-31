import { useEffect, useState } from 'react';
import type { DiffTarget } from '../../shared/types';
import { api } from '../api';
import { parseDiff, toSplit, type DiffLine, type ParsedDiff } from '../diff';
import { useUi } from '../ui';
import { Icon } from './Icons';

type Mode = 'unified' | 'split';

export function DiffView({ repo, target, onClose }: { repo: string; target: DiffTarget; onClose: () => void }) {
  if (target.kind === 'working' && target.conflict) return <ConflictView repo={repo} path={target.path} onClose={onClose} />;
  return <PatchView repo={repo} target={target} onClose={onClose} />;
}

function PatchView({ repo, target, onClose }: { repo: string; target: DiffTarget; onClose: () => void }) {
  const [diff, setDiff] = useState<ParsedDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('arbor.diffMode') as Mode) || 'unified');

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(null);
    api
      .diff(repo, target)
      .then((raw) => alive && setDiff(parseDiff(raw)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, JSON.stringify(target)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changeMode = (m: Mode) => {
    setMode(m);
    localStorage.setItem('arbor.diffMode', m);
  };

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
        {diff && !diff.binary && diff.hunks.length === 0 && <div className="empty">Aucune différence de contenu (mode ou renommage).</div>}
        {diff?.hunks.map((h, i) => (
          <div className="hunk" key={i}>
            <div className="hunk-head">{h.header}</div>
            {mode === 'unified' ? (
              <table className="code">
                <tbody>
                  {h.lines.map((l, k) => (
                    <tr key={k} className={`ln-${l.type}`}>
                      <td className="no">{l.oldNo ?? ''}</td>
                      <td className="no">{l.newNo ?? ''}</td>
                      <td className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
                      <td className="txt">{l.text}</td>
                    </tr>
                  ))}
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
function ConflictView({ repo, path, onClose }: { repo: string; path: string; onClose: () => void }) {
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
