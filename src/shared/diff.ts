// Analyse d'un patch unifié, partagée entre le rendu (affichage) et le processus principal (indexation partielle).

export interface DiffLine {
  type: 'ctx' | 'add' | 'del' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: Hunk[];
  binary: boolean;
  additions: number;
  deletions: number;
  /** Fichier créé (« new file mode ») : seule l'indexation du fichier entier a un sens. */
  newFile?: boolean;
  /** Fichier supprimé (« deleted file mode »). */
  deletedFile?: boolean;
  /**
   * Sous-module (mode 160000, sortie de `--submodule=short`) : commits avant et après (null = absent de ce côté),
   * `dirty` = le sous-module a des modifications non commitées. Les blocs « Subproject commit » restent dans `hunks`
   * mais ne doivent pas être affichés ni indexés partiellement.
   */
  submodule?: SubmoduleChange;
}

export interface SubmoduleChange {
  old: string | null;
  new: string | null;
  dirty: boolean;
}

/** En-tête d'un diff de sous-module : un des modes (avant ou après) vaut 160000. */
const SUBMODULE_HEADER = /^(?:index [0-9a-f]+\.\.[0-9a-f]+ 160000|(?:new|deleted) file mode 160000|(?:old|new) mode 160000)$/m;
const SUBPROJECT_LINE = /^([+-])Subproject commit ([0-9a-f]{4,64})(-dirty)?$/;

/**
 * Commits d'un diff de sous-module (`--submodule=short`), null si `raw` ne concerne pas un sous-module. Reconnu par
 * un mode 160000 dans l'en-tête ; sans ligne `index` (même commit, modifications seules), par des blocs faits
 * uniquement de lignes « Subproject commit » (un fichier ordinaire modifié a toujours sa ligne `index`).
 */
export function parseSubmoduleChange(raw: string): SubmoduleChange | null {
  const start = raw.search(/^@@ /m);
  const header = start < 0 ? raw : raw.slice(0, start);
  const byMode = SUBMODULE_HEADER.test(header);
  if (!byMode && (start < 0 || /^index /m.test(header))) return null;
  const change: SubmoduleChange = { old: null, new: null, dirty: false };
  for (const line of raw.slice(start < 0 ? raw.length : start).split('\n')) {
    if (line.startsWith('@@') || line === '' || line.startsWith('\\')) continue;
    const m = line.match(SUBPROJECT_LINE);
    if (!m) {
      if (byMode) continue;
      return null;
    }
    if (m[1] === '-') change.old = m[2];
    else {
      change.new = m[2];
      if (m[3]) change.dirty = true;
    }
  }
  return byMode || change.old !== null || change.new !== null ? change : null;
}

export function parseDiff(raw: string): ParsedDiff {
  const result: ParsedDiff = { hunks: [], binary: /^Binary files .* differ$/m.test(raw), additions: 0, deletions: 0 };
  // Ces lignes n'apparaissent que dans l'en-tête : une ligne de contenu commence par « + », « - » ou une espace.
  if (/^new file mode /m.test(raw)) result.newFile = true;
  if (/^deleted file mode /m.test(raw)) result.deletedFile = true;
  const submodule = parseSubmoduleChange(raw);
  if (submodule) result.submodule = submodule;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of raw.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: line, lines: [] };
      result.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
      result.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
      result.deletions++;
    } else if (line.startsWith('\\')) {
      hunk.lines.push({ type: 'meta', text: line });
    } else if (line.startsWith(' ') || line === '') {
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  // Supprime la ligne de contexte vide ajoutée par le saut de ligne final.
  const lastHunk = result.hunks[result.hunks.length - 1];
  if (lastHunk && raw.endsWith('\n')) {
    const tail = lastHunk.lines[lastHunk.lines.length - 1];
    if (tail?.type === 'ctx' && tail.text === '') lastHunk.lines.pop();
  }
  return result;
}
