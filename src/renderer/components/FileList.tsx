import type { DiffTarget, FileChange } from '../../shared/types';
import type { MenuItem } from './ContextMenu';
import { useUi } from '../ui';
import { splitPath } from '../util';

const STATUS_LABEL: Record<string, string> = { M: 'Modifié', A: 'Ajouté', D: 'Supprimé', R: 'Renommé', C: 'Copié', U: 'Conflit', '?': 'Nouveau', T: 'Type modifié' };

interface Props {
  files: FileChange[];
  diffFor: (f: FileChange) => DiffTarget;
  activeDiff: DiffTarget | null;
  action?: { label: string; onClick: (f: FileChange) => void };
  menu?: (f: FileChange) => MenuItem[];
}

export function FileList({ files, diffFor, activeDiff, action, menu }: Props) {
  const ui = useUi();
  return (
    <ul className="files">
      {files.map((f) => {
        const target = diffFor(f);
        const active = !!activeDiff && JSON.stringify(activeDiff) === JSON.stringify(target);
        const { dir, file } = splitPath(f.path);
        return (
          <li
            key={f.path}
            className={`file${active ? ' active' : ''}`}
            onClick={() => ui.showDiff(target)}
            onContextMenu={menu ? (e) => ui.openMenu(e, menu(f)) : undefined}
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          >
            <span className={`status status-${f.status === '?' ? 'N' : f.status}`} title={STATUS_LABEL[f.status]}>
              {f.status === '?' ? 'N' : f.status}
            </span>
            <span className="file-path">
              <span className="file-name">{file}</span>
              {dir && <span className="file-dir">{dir}</span>}
            </span>
            {action && (
              <button
                className="file-action"
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick(f);
                }}
              >
                {action.label}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
