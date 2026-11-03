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
}

export function parseDiff(raw: string): ParsedDiff {
  const result: ParsedDiff = { hunks: [], binary: /^Binary files .* differ$/m.test(raw), additions: 0, deletions: 0 };
  // Ces lignes n'apparaissent que dans l'en-tête : une ligne de contenu commence par « + », « - » ou une espace.
  if (/^new file mode /m.test(raw)) result.newFile = true;
  if (/^deleted file mode /m.test(raw)) result.deletedFile = true;
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
