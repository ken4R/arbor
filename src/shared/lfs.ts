// Git LFS : fonctions pures partagées par le processus principal (analyse des sorties de `git lfs`, validation des
// motifs) et par le rendu (pointeurs dans les diffs, tailles). Sorties vérifiées sur git-lfs 3.4.1.

import type { LfsFile, LfsPattern } from './types';

/** Version de `git lfs version` (« git-lfs/3.4.1 (GitHub; linux amd64; go 1.22.2) ») ; null si illisible. */
export function parseLfsVersion(out: string): string | null {
  return out.match(/git-lfs\/(\d+(?:\.\d+)*)/)?.[1] ?? null;
}

/**
 * Motifs de `git lfs track` sans argument (texte) :
 * « Listing tracked patterns / ␣␣␣␣*.bin (.gitattributes) / Listing excluded patterns / ␣␣␣␣x.bin (.gitattributes) ».
 * La source est entre les dernières parenthèses de la ligne (un motif peut contenir des parenthèses).
 */
export function parseLfsTrack(out: string): LfsPattern[] {
  const result: LfsPattern[] = [];
  let excluded: boolean | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (/^Listing tracked patterns/.test(line)) excluded = false;
    else if (/^Listing excluded patterns/.test(line)) excluded = true;
    else if (excluded !== null && /^\s+\S/.test(line)) {
      const m = line.trim().match(/^(.*\S)\s+\(([^()]*)\)$/);
      if (m) result.push({ pattern: m[1], source: m[2], excluded });
    }
  }
  return result;
}

/** Motifs de `git lfs track --json` (`{ patterns: [{ pattern, source, tracked }] }`) ; null si la sortie est illisible. */
export function parseLfsTrackJson(out: string): LfsPattern[] | null {
  let data: unknown;
  try {
    data = JSON.parse(out);
  } catch {
    return null;
  }
  const list = (data as { patterns?: unknown })?.patterns;
  if (list === null) return [];
  if (!Array.isArray(list)) return null;
  return list.flatMap((p: { pattern?: unknown; source?: unknown; tracked?: unknown }) =>
    typeof p?.pattern === 'string' && p.pattern !== ''
      ? [{ pattern: p.pattern, source: typeof p.source === 'string' ? p.source : '.gitattributes', excluded: p.tracked === false }]
      : [],
  );
}

/**
 * Repli sans git-lfs : motifs du `.gitattributes` racine. `filter=lfs` = suivi ; `-filter`, `!filter` = exclusion
 * (comme `git lfs track`). Commentaires et macros (`[attr]…`) ignorés ; motif entre guillemets accepté.
 */
export function parseGitattributesLfs(text: string, source = '.gitattributes'): LfsPattern[] {
  const result: LfsPattern[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('[attr]')) continue;
    let pattern: string;
    let rest: string;
    if (line.startsWith('"')) {
      const end = line.slice(1).search(/(?<!\\)"/);
      if (end < 0) continue;
      pattern = line.slice(1, end + 1).replace(/\\(["\\])/g, '$1');
      rest = line.slice(end + 2);
    } else {
      const m = line.match(/^(\S+)(.*)$/);
      if (!m) continue;
      [, pattern, rest] = m;
    }
    const attrs = rest.split(/\s+/).filter(Boolean);
    if (attrs.includes('filter=lfs')) result.push({ pattern, source, excluded: false });
    else if (attrs.includes('-filter') || attrs.includes('!filter')) result.push({ pattern, source, excluded: true });
  }
  return result;
}

/** Ligne de `git lfs ls-files -l` : `oid SP (*|-) SP chemin` (`*` contenu extrait, `-` pointeur seul). */
const LS_FILES_LINE = /^([0-9a-f]{64}) ([*-]) (.*)$/;

/** Fichiers de `git lfs ls-files -l` (texte, sans tailles). */
export function parseLfsFiles(out: string): LfsFile[] {
  return out.split('\n').flatMap((line) => {
    const m = line.match(LS_FILES_LINE);
    return m ? [{ path: m[3], oid: m[1], present: m[2] === '*', size: null }] : [];
  });
}

/**
 * Fichiers de `git lfs ls-files --json` (`{ files: [{ name, size, checkout, oid }] }`, `files: null` si aucun) ;
 * `present` = le fichier de l'arbre de travail est le contenu (`checkout`), pas le pointeur. null si illisible.
 */
export function parseLfsFilesJson(out: string): LfsFile[] | null {
  let data: unknown;
  try {
    data = JSON.parse(out);
  } catch {
    return null;
  }
  const list = (data as { files?: unknown })?.files;
  if (list === null) return [];
  if (!Array.isArray(list)) return null;
  return list.flatMap((f: { name?: unknown; size?: unknown; checkout?: unknown; oid?: unknown }) =>
    typeof f?.name === 'string' && typeof f.oid === 'string'
      ? [{ path: f.name, oid: f.oid, present: f.checkout === true, size: typeof f.size === 'number' ? f.size : null }]
      : [],
  );
}

/** Chemins dont l'attribut `filter` vaut `lfs` d'après `git check-attr -z --stdin filter` (`chemin NUL filter NUL valeur NUL`…). */
export function lfsPathsFromCheckAttr(out: string): string[] {
  const parts = out.split('\0');
  const result: string[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 1] === 'filter' && parts[i + 2] === 'lfs') result.push(parts[i]);
  return result;
}

/**
 * Motif à suivre ou à ne plus suivre : message d'erreur en français, ou null s'il est acceptable. Refusés : vide,
 * saut de ligne ou caractère de contrôle (écrirait une autre ligne dans `.gitattributes`), `-` en tête (option), `#`
 * en tête (commentaire), `!` en tête (motif négatif interdit par Git dans `.gitattributes`).
 */
export function lfsPatternError(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern.trim() === '') return 'Le motif est vide.';
  if (/[\0-\x1f\x7f]/.test(pattern)) return 'Le motif ne doit contenir ni saut de ligne ni caractère de contrôle.';
  if (pattern !== pattern.trim()) return 'Le motif ne doit pas commencer ni finir par une espace.';
  if (pattern.startsWith('-')) return 'Le motif ne doit pas commencer par « - ».';
  if (pattern.startsWith('#') || pattern.startsWith('!')) return 'Le motif ne doit pas commencer par « # » ni par « ! ».';
  return null;
}

/**
 * Chemin à passer à `git lfs pull --include=` : la liste est séparée par des virgules et chaque élément est un motif.
 * Refusés : virgule, caractères de motif (`*`, `?`, `[`, `]`, `\`), `!` ou `#` en tête, caractère de contrôle.
 */
export function lfsIncludeError(path: string): string | null {
  if (!path || /[\0-\x1f\x7f]/.test(path)) return 'Chemin invalide.';
  if (/[,*?[\]\\]/.test(path) || path.startsWith('!') || path.startsWith('#'))
    return `« ${path} » contient un caractère que git-lfs lirait comme un motif : récupérez tous les fichiers LFS.`;
  return null;
}

export interface LfsPointer {
  oid: string;
  size: number;
}

const POINTER_VERSIONS = ['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1'];

/**
 * Pointeur LFS (spécification v1) : `version …` en première ligne, puis `oid sha256:<64 hex>` et `size <n>` (autres
 * clés `ext-…` tolérées). null si le texte n'est pas un pointeur.
 */
export function parseLfsPointer(text: string): LfsPointer | null {
  if (text.length > 1024) return null;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const [first, ...rest] = lines;
  const version = first?.match(/^version (\S+)$/)?.[1];
  if (!version || !POINTER_VERSIONS.includes(version)) return null;
  let oid: string | null = null;
  let size: number | null = null;
  for (const line of rest) {
    const m = line.match(/^([a-z0-9.-]+) (.*)$/);
    if (!m) return null;
    if (m[1] === 'oid') oid = m[2].match(/^sha256:([0-9a-f]{64})$/)?.[1] ?? null;
    else if (m[1] === 'size') size = /^\d+$/.test(m[2]) ? Number(m[2]) : null;
  }
  return oid !== null && size !== null ? { oid, size } : null;
}

/** Changement d'un fichier LFS : pointeurs avant et après (null = absent de ce côté). */
export interface LfsPointerChange {
  old: LfsPointer | null;
  new: LfsPointer | null;
}

/**
 * Pointeurs avant et après d'un diff (sortie de `diff()`, `--no-textconv` : Git compare les pointeurs). Les deux
 * versions sont reconstruites à partir des blocs (contexte + lignes retirées, contexte + lignes ajoutées). null si le
 * diff ne concerne pas un seul fichier dont toutes les versions présentes sont des pointeurs.
 */
export function lfsPointerChange(raw: string): LfsPointerChange | null {
  const sections = raw.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '));
  if (sections.length !== 1) return null;
  const text = sections[0];
  const start = text.search(/^@@ /m);
  if (start < 0) return null;
  const header = text.slice(0, start);
  if (/^(?:Binary files|GIT binary patch)/m.test(header)) return null;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of text.slice(start).split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\') || line === '') continue;
    const body = line.slice(1);
    if (line[0] === ' ') {
      oldLines.push(body);
      newLines.push(body);
    } else if (line[0] === '-') oldLines.push(body);
    else if (line[0] === '+') newLines.push(body);
    else return null;
  }
  const newFile = /^new file mode /m.test(header);
  const deleted = /^deleted file mode /m.test(header);
  const side = (lines: string[], absent: boolean): LfsPointer | null | undefined => {
    if (absent) return null;
    return parseLfsPointer(lines.join('\n')) ?? undefined;
  };
  const before = side(oldLines, newFile);
  const after = side(newLines, deleted);
  if (before === undefined || after === undefined || (before === null && after === null)) return null;
  return { old: before, new: after };
}

/** Taille lisible en français : « 512 octets », « 19,5 Ko », « 2,0 Mo ». */
export function formatLfsSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} octet${bytes > 1 ? 's' : ''}`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1).replace('.', ',')} ${units[i]}`;
}
