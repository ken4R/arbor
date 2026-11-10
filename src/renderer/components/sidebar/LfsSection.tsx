import { useEffect, useState } from 'react';
import type { LfsFile, LfsFiles, RepoSnapshot } from '../../../shared/types';
import { formatLfsSize } from '../../../shared/lfs';
import { lfsFileMenu, lfsPatternMenu, lfsPullAction, lfsTrackAction } from '../../actions';
import { api } from '../../api';
import { LFS_MISSING_TEXT, lfsMissing, useLfsError, useLfsFilesGeneration, useLfsInfo } from '../../lfs';
import { useUi } from '../../ui';
import { IconLfs, IconLfsTrack, Icon } from '../Icons';
import { Section } from './Section';

/**
 * Section LFS (présente si le dépôt utilise LFS), repliée par défaut : motifs suivis ou exclus, puis fichiers LFS.
 * La liste des fichiers (`git lfs ls-files`, coûteuse) n'est lue que lorsque la section est ouverte.
 */
export function LfsSection({ snap, match }: { snap: RepoSnapshot; match: (s: string) => boolean; onSelectCommit: (sha: string) => void }) {
  const ui = useUi();
  const info = useLfsInfo(snap);
  const error = useLfsError(snap.path);
  if (!snap.features?.lfs) return null;
  const repo = snap.path;
  const installed = !!info?.installed;
  const patterns = (info?.patterns ?? []).filter((p) => match(p.pattern));
  const tracked = (info?.patterns ?? []).filter((p) => !p.excluded).length;
  const actions = installed
    ? [
        { icon: <IconLfsTrack />, title: 'Suivre un motif LFS…', onClick: () => lfsTrackAction(ui, repo) },
        { icon: <Icon.pull />, title: 'Récupérer tous les fichiers LFS (pull)', onClick: () => void lfsPullAction(ui, repo, null) },
      ]
    : [];

  return (
    <Section id="lfs" title="LFS" count={tracked} icon={<IconLfs />} collapsed actions={actions}>
      {lfsMissing(snap, info) && <div className="lfs-warning">{LFS_MISSING_TEXT}</div>}
      {error && <div className="side-empty">{error}</div>}
      <div className="lfs-subhead">Motifs (.gitattributes)</div>
      {patterns.map((p) => (
        <div
          key={`${p.source}\0${p.pattern}`}
          className={`side-item lfs-pattern${p.excluded ? ' side-item-off' : ''}`}
          title={`${p.excluded ? 'Exclu de LFS' : 'Suivi par LFS'} : ${p.pattern}\nDéclaré dans ${p.source}`}
          onContextMenu={(e) => ui.openMenu(e, lfsPatternMenu(ui, repo, p, installed))}
        >
          <span className="side-label">{p.pattern}</span>
          {p.source !== '.gitattributes' && <span className="lfs-tag">{p.source}</span>}
          {p.excluded && <span className="lfs-tag">exclu</span>}
        </div>
      ))}
      {info && patterns.length === 0 && <div className="side-empty">Aucun motif</div>}
      {installed && <LfsFileList snap={snap} match={match} />}
    </Section>
  );
}

/**
 * Fichiers LFS, lus au montage (section ouverte) puis seulement quand HEAD change ou après une action LFS. Un fichier
 * modifié localement (statut) n'est jamais affiché « pointeur seul » : git-lfs ne le dit pas extrait, mais son
 * contenu n'est pas un pointeur à récupérer.
 */
function LfsFileList({ snap, match }: { snap: RepoSnapshot; match: (s: string) => boolean }) {
  const ui = useUi();
  const repo = snap.path;
  const generation = useLfsFilesGeneration();
  const key = `${repo}\0${snap.head}\0${generation}`;
  const modified = new Set([...snap.status.unstaged, ...snap.status.staged].map((f) => f.path));
  const pointerOnly = (f: LfsFile) => !f.present && !modified.has(f.path) && f.downloaded !== true;
  const fetched = (f: LfsFile) => !f.present && !modified.has(f.path) && f.downloaded === true;
  const [list, setList] = useState<LfsFiles | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .lfsFiles(repo)
      .then((r) => {
        if (!alive) return;
        setList(r);
        setError(null);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = (list?.files ?? []).filter((f) => match(f.path));
  const pointers = (list?.files ?? []).filter(pointerOnly).length;
  const state = (f: LfsFile) =>
    modified.has(f.path)
      ? 'Modifié localement'
      : f.present
        ? 'Contenu extrait'
        : fetched(f)
          ? 'Objet téléchargé, non extrait : double-clic pour l\'extraire'
          : 'Pointeur seul : double-clic pour récupérer le contenu';
  return (
    <>
      <div className="lfs-subhead">
        Fichiers{list ? ` (${list.files.length}${list.truncated ? '+' : ''})` : ''}
        {pointers > 0 && <span className="lfs-subhead-note">{pointers} pointeur{pointers > 1 ? 's' : ''} seul{pointers > 1 ? 's' : ''}</span>}
      </div>
      {!list && !error && <div className="side-empty">Chargement…</div>}
      {error && <div className="side-empty">{error}</div>}
      {files.map((f) => (
        <div
          key={f.path}
          className={`side-item lfs-file${pointerOnly(f) ? ' lfs-file-pointer' : ''}`}
          title={`${f.path}\noid ${f.oid.slice(0, 12)}…${f.size !== null ? `\n${formatLfsSize(f.size)}` : ''}\n${state(f)}`}
          onDoubleClick={() => (pointerOnly(f) || fetched(f)) && void lfsPullAction(ui, repo, [f.path])}
          onContextMenu={(e) => ui.openMenu(e, lfsFileMenu(ui, repo, f, modified.has(f.path)))}
        >
          <span className="side-label">{f.path}</span>
          {modified.has(f.path) && <span className="lfs-tag">modifié</span>}
          {pointerOnly(f) && <span className="lfs-tag lfs-tag-pointer">pointeur seul</span>}
          {fetched(f) && <span className="lfs-tag lfs-tag-pointer">non extrait</span>}
          {f.size !== null && <span className="lfs-size">{formatLfsSize(f.size)}</span>}
        </div>
      ))}
      {list && list.files.length === 0 && <div className="side-empty">Aucun fichier LFS</div>}
      {list?.truncated && <div className="side-empty">Liste limitée aux 1 000 premiers fichiers.</div>}
    </>
  );
}
