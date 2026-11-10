import { useEffect, useState } from 'react';
import type { LfsFiles, RepoSnapshot } from '../../../shared/types';
import { formatLfsSize } from '../../../shared/lfs';
import { lfsFileMenu, lfsPatternMenu, lfsPullAction, lfsTrackAction } from '../../actions';
import { api } from '../../api';
import { LFS_MISSING_TEXT, lfsMissing, useLfsError, useLfsFilesGeneration, useLfsInfo } from '../../lfs';
import { useUi } from '../../ui';
import { Icon, IconRemoteAdd } from '../Icons';
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
        { icon: <IconRemoteAdd />, title: 'Suivre un motif LFS…', onClick: () => lfsTrackAction(ui, repo) },
        { icon: <Icon.pull />, title: 'Récupérer tous les fichiers LFS (pull)', onClick: () => void lfsPullAction(ui, repo, null) },
      ]
    : [];

  return (
    <Section id="lfs" title="LFS" count={tracked} icon={<Icon.stash />} collapsed actions={actions}>
      {lfsMissing(snap, info) && <div className="lfs-warning">{LFS_MISSING_TEXT}</div>}
      {error && <div className="side-empty">{error}</div>}
      <div className="lfs-subhead">Motifs{info && !installed ? ' (.gitattributes)' : ''}</div>
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

/** Fichiers LFS, lus au montage (section ouverte) puis à chaque commit, changement du statut ou action LFS. */
function LfsFileList({ snap, match }: { snap: RepoSnapshot; match: (s: string) => boolean }) {
  const ui = useUi();
  const repo = snap.path;
  const generation = useLfsFilesGeneration();
  const st = snap.status;
  const key = `${repo}\0${snap.head}\0${st.staged.length}\0${st.unstaged.length}\0${generation}`;
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
  const pointers = (list?.files ?? []).filter((f) => !f.present).length;
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
          className={`side-item lfs-file${f.present ? '' : ' lfs-file-pointer'}`}
          title={`${f.path}\noid ${f.oid.slice(0, 12)}…${f.size !== null ? `\n${formatLfsSize(f.size)}` : ''}\n${
            f.present ? 'Contenu extrait' : 'Pointeur seul : double-clic pour récupérer le contenu'
          }`}
          onDoubleClick={() => !f.present && void lfsPullAction(ui, repo, [f.path])}
          onContextMenu={(e) => ui.openMenu(e, lfsFileMenu(ui, repo, f))}
        >
          <span className="side-label">{f.path}</span>
          {!f.present && <span className="lfs-tag lfs-tag-pointer">pointeur seul</span>}
          {f.size !== null && <span className="lfs-size">{formatLfsSize(f.size)}</span>}
        </div>
      ))}
      {list && list.files.length === 0 && <div className="side-empty">Aucun fichier LFS</div>}
      {list?.truncated && <div className="side-empty">Liste limitée aux 1 000 premiers fichiers.</div>}
    </>
  );
}
