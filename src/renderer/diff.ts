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
}

export function parseDiff(raw: string): ParsedDiff {
  const result: ParsedDiff = { hunks: [], binary: /^Binary files .* differ$/m.test(raw), additions: 0, deletions: 0 };
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

/** Associe lignes supprimées et ajoutées pour l'affichage côte à côte. */
export function toSplit(lines: DiffLine[]): [DiffLine | null, DiffLine | null][] {
  const out: [DiffLine | null, DiffLine | null][] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === 'del' || l.type === 'add') {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
      while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push([dels[k] ?? null, adds[k] ?? null]);
    } else {
      out.push([l, l]);
      i++;
    }
  }
  return out;
}
