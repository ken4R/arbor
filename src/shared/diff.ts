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
  /** Changement de type : un fichier ordinaire devient un sous-module, ou l'inverse. */
  typeChange?: boolean;
}

/** En-tête d'un diff de sous-module : un des modes (avant ou après) vaut 160000. */
const SUBMODULE_HEADER = /^(?:index [0-9a-f]+\.\.[0-9a-f]+ 160000|(?:new|deleted) file mode 160000|(?:old|new) mode 160000)$/m;
const SUBPROJECT_LINE = /^([+-])Subproject commit ([0-9a-f]{4,64})(-dirty)?$/;

/**
 * Commits d'un diff de sous-module (`--submodule=short`), null si `raw` ne concerne pas un sous-module. Reconnu par
 * un mode 160000 dans l'en-tête de n'importe quelle section (un changement de type fichier ↔ sous-module produit deux
 * sections : seules les lignes de la section du gitlink sont lues) ; sans ligne `index` (même commit, modifications
 * seules), par des blocs faits uniquement de lignes « Subproject commit » (un fichier ordinaire modifié a toujours sa
 * ligne `index`).
 */
export function parseSubmoduleChange(raw: string): SubmoduleChange | null {
  const sections = raw
    .split(/^(?=diff --git )/m)
    .filter(Boolean)
    .map((text) => {
      const start = text.search(/^@@ /m);
      const header = start < 0 ? text : text.slice(0, start);
      return { header, body: start < 0 ? '' : text.slice(start), gitlink: SUBMODULE_HEADER.test(header) };
    });
  const change: SubmoduleChange = { old: null, new: null, dirty: false };
  const read = (body: string, strict: boolean): boolean => {
    for (const line of body.split('\n')) {
      if (line.startsWith('@@') || line === '' || line.startsWith('\\')) continue;
      const m = line.match(SUBPROJECT_LINE);
      if (!m) {
        if (strict) return false;
        continue;
      }
      if (m[1] === '-') change.old = m[2];
      else {
        change.new = m[2];
        if (m[3]) change.dirty = true;
      }
    }
    return true;
  };
  if (sections.some((x) => x.gitlink)) {
    for (const x of sections) if (x.gitlink) read(x.body, false);
    if (sections.some((x) => !x.gitlink)) change.typeChange = true;
    return change;
  }
  const [only] = sections;
  if (sections.length !== 1 || !only.body || /^index /m.test(only.header)) return null;
  if (!read(only.body, true)) return null;
  return change.old !== null || change.new !== null ? change : null;
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
