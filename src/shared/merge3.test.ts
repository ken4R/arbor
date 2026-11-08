import { describe, expect, it } from 'vitest';
import fixtures from './merge3.fixtures.json';
import {
  blockSide,
  blocksFromMergeOutput,
  composeResult,
  diffLines,
  isMarkerLine,
  markerSize,
  merge3,
  normalizeConflictText,
  parseMergeOutput,
  resolveBlock,
  splitLines,
  type Choice,
  type MergeBlock,
} from './merge3';

const L = (n: number) => Array.from({ length: n }, (_, i) => `ligne ${i + 1}`);
const set = (lines: string[], at: Record<number, string[]>) => lines.flatMap((l, i) => at[i + 1] ?? [l]);
/** Applique les blocs de diff à `a` : doit redonner `b`. */
const applyHunks = (a: string[], b: string[], hunks: ReturnType<typeof diffLines>) => {
  const out: string[] = [];
  let pos = 0;
  for (const h of hunks) {
    out.push(...a.slice(pos, h.aStart), ...b.slice(h.bStart, h.bEnd));
    pos = h.aEnd;
  }
  return [...out, ...a.slice(pos)];
};

describe('splitLines', () => {
  it('découpe en LF avec saut final', () => {
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], eol: '\n', finalNewline: true });
  });
  it('sans saut final, vide, ligne vide seule', () => {
    expect(splitLines('a\nb')).toEqual({ lines: ['a', 'b'], eol: '\n', finalNewline: false });
    expect(splitLines('')).toEqual({ lines: [], eol: '\n', finalNewline: false });
    expect(splitLines('\n')).toEqual({ lines: [''], eol: '\n', finalNewline: true });
  });
  it('détecte CRLF et retire les \\r', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual({ lines: ['a', 'b'], eol: '\r\n', finalNewline: true });
  });
  it('fichier mixte : fin de ligne majoritaire', () => {
    expect(splitLines('a\r\nb\nc\n').eol).toBe('\n');
    expect(splitLines('a\r\nb\r\nc\n').eol).toBe('\r\n');
  });
});

describe('diffLines', () => {
  it('textes identiques : aucun bloc', () => {
    expect(diffLines(L(5), L(5))).toEqual([]);
  });
  it('insertion, suppression, remplacement', () => {
    expect(diffLines(['a', 'c'], ['a', 'b', 'c'])).toEqual([{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);
    expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 }]);
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
    expect(diffLines([], ['a'])).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);
    expect(diffLines(['a'], [])).toEqual([{ aStart: 0, aEnd: 1, bStart: 0, bEnd: 0 }]);
  });
  it('chemin minimal sur un exemple classique (ABCABBA / CBABAC)', () => {
    const a = 'ABCABBA'.split('');
    const b = 'CBABAC'.split('');
    const hunks = diffLines(a, b);
    expect(applyHunks(a, b, hunks)).toEqual(b);
    const edits = hunks.reduce((n, h) => n + (h.aEnd - h.aStart) + (h.bEnd - h.bStart), 0);
    expect(edits).toBe(5); // distance d'édition de Myers
  });
  it('reconstruit b à partir de a sur des textes pseudo-aléatoires', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let t = 0; t < 50; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 60) }, () => String.fromCharCode(97 + Math.floor(rnd() * 5)));
      const b = Array.from({ length: Math.floor(rnd() * 60) }, () => String.fromCharCode(97 + Math.floor(rnd() * 5)));
      const hunks = diffLines(a, b);
      expect(applyHunks(a, b, hunks)).toEqual(b);
      for (let k = 1; k < hunks.length; k++) expect(hunks[k].aStart).toBeGreaterThan(hunks[k - 1].aEnd);
    }
  });
});

describe('merge3', () => {
  it('trois versions identiques : un seul bloc commun', () => {
    expect(merge3(L(3), L(3), L(3))).toEqual([{ kind: 'same', lines: L(3) }]);
  });
  it('changement d’un seul côté', () => {
    const blocks = merge3(L(5), set(L(5), { 3: ['trois'] }), L(5));
    expect(blocks).toEqual([
      { kind: 'same', lines: L(2) },
      { kind: 'mine', base: ['ligne 3'], lines: ['trois'] },
      { kind: 'same', lines: ['ligne 4', 'ligne 5'] },
    ]);
    expect(merge3(L(5), L(5), set(L(5), { 3: ['trois'] }))[1]).toEqual({ kind: 'theirs', base: ['ligne 3'], lines: ['trois'] });
  });
  it('même changement des deux côtés : pas de conflit', () => {
    const v = set(L(5), { 2: ['deux'] });
    expect(merge3(L(5), v, v)[1]).toEqual({ kind: 'both', base: ['ligne 2'], lines: ['deux'] });
  });
  it('vrai conflit', () => {
    expect(merge3(L(5), set(L(5), { 3: ['m'] }), set(L(5), { 3: ['t'] }))[1]).toEqual({ kind: 'conflict', base: ['ligne 3'], mine: ['m'], theirs: ['t'] });
  });
  it('changements adjacents : conflit (comme xdiff)', () => {
    const blocks = merge3(L(6), set(L(6), { 3: ['m3'] }), set(L(6), { 4: ['t4'] }));
    expect(blocks[1]).toEqual({ kind: 'conflict', base: ['ligne 3', 'ligne 4'], mine: ['m3', 'ligne 4'], theirs: ['ligne 3', 't4'] });
  });
  it('changements séparés par une ligne : pas de conflit', () => {
    const blocks = merge3(L(6), set(L(6), { 2: ['m2'] }), set(L(6), { 4: ['t4'] }));
    expect(blocks.map((b) => b.kind)).toEqual(['same', 'mine', 'same', 'theirs', 'same']);
  });
  it('ajout en fin de fichier', () => {
    expect(merge3(L(2), [...L(2), 'fin'], L(2))).toEqual([{ kind: 'same', lines: L(2) }, { kind: 'mine', base: [], lines: ['fin'] }]);
    expect(merge3(L(2), [...L(2), 'm'], [...L(2), 't']).at(-1)).toEqual({ kind: 'conflict', base: [], mine: ['m'], theirs: ['t'] });
  });
  it('base vide', () => {
    expect(merge3([], ['a'], ['a'])).toEqual([{ kind: 'both', base: [], lines: ['a'] }]);
    expect(merge3([], ['a'], ['b'])).toEqual([{ kind: 'conflict', base: [], mine: ['a'], theirs: ['b'] }]);
    expect(merge3([], [], [])).toEqual([]);
  });
  it('CRLF : fusion sur les lignes sans \\r, fin de ligne restituée', () => {
    const base = splitLines('a\r\nb\r\nc\r\n');
    const mine = splitLines('a\r\nB\r\nc\r\n');
    const theirs = splitLines('a\r\nb\r\nc\r\nd\r\n');
    const blocks = merge3(base.lines, mine.lines, theirs.lines);
    expect(composeResult(blocks, new Map(), mine.eol, mine.finalNewline)).toBe('a\r\nB\r\nc\r\nd\r\n');
  });
  it('les blocs couvrent exactement la base et chaque côté', () => {
    const base = L(30);
    const mine = set(base, { 2: [], 10: ['x', 'y'], 20: ['vingt'] });
    const theirs = set(base, { 10: ['z'], 25: ['a', 'ligne 25'] });
    const blocks = merge3(base, mine, theirs);
    for (const side of ['base', 'mine', 'theirs'] as const) {
      expect(blocks.flatMap((b) => blockSide(b, side))).toEqual({ base, mine, theirs }[side]);
    }
  });
});

describe('composeResult', () => {
  const blocks: MergeBlock[] = [
    { kind: 'same', lines: ['début'] },
    { kind: 'conflict', base: ['b'], mine: ['m'], theirs: ['t'] },
    { kind: 'theirs', base: ['x'], lines: ['X'] },
    { kind: 'same', lines: ['fin'] },
  ];
  const result = (c: Choice | undefined) => composeResult(blocks, new Map(c === undefined ? [] : [[1, c]]), '\n', true);

  it('écrit des marqueurs diff3 pour un conflit non résolu', () => {
    expect(result(undefined)).toBe('début\n<<<<<<< ma version\nm\n||||||| base\nb\n=======\nt\n>>>>>>> leur version\nX\nfin\n');
  });
  it('applique chaque choix', () => {
    expect(result('mine')).toBe('début\nm\nX\nfin\n');
    expect(result('theirs')).toBe('début\nt\nX\nfin\n');
    expect(result('mine-theirs')).toBe('début\nm\nt\nX\nfin\n');
    expect(result('theirs-mine')).toBe('début\nt\nm\nX\nfin\n');
    expect(result('base')).toBe('début\nb\nX\nfin\n');
    expect(result({ custom: ['libre', ''] })).toBe('début\nlibre\n\nX\nfin\n');
    expect(result({ custom: [] })).toBe('début\nX\nfin\n');
  });
  it('un bloc sans conflit peut être ramené à la base ou à l’autre côté', () => {
    expect(composeResult(blocks, new Map<number, Choice>([[1, 'mine'], [2, 'mine']]), '\n', true)).toBe('début\nm\nx\nfin\n');
    expect(resolveBlock(blocks[2], 'base')).toEqual(['x']);
    expect(resolveBlock(blocks[0], { custom: ['autre'] })).toEqual(['autre']);
  });
  it('fin de ligne et saut final', () => {
    expect(composeResult(blocks, new Map([[1, 'mine']]), '\r\n', false)).toBe('début\r\nm\r\nX\r\nfin');
    expect(composeResult([], new Map(), '\n', true)).toBe('');
    expect(composeResult([{ kind: 'same', lines: [''] }], new Map(), '\n', true)).toBe('\n');
  });
});

describe('isMarkerLine', () => {
  it('reconnaît les marqueurs, pas le texte ordinaire', () => {
    expect(['<<<<<<< HEAD', '=======', '>>>>>>> autre', '||||||| base', '<<<<<<<'].every(isMarkerLine)).toBe(true);
    expect(['<<<<<<<<', '== titre', 'a <<<<<<< b', '======== ='].some(isMarkerLine)).toBe(false);
  });
});

// `merge3.fixtures.json` a été généré une fois par `git merge-file -p --diff3 -L "ma version" -L base -L "leur version"
// mine base theirs` (git 2.43) : cas écrits à la main, l'exemple de la relecture et des cas aléatoires sur un
// alphabet de 5 lettres (lignes répétées). Le test ne lance pas git : il vérifie l'analyse de la sortie de Git.
type Fixture = { name: string; base: string; mine: string; theirs: string; expected: string };
const finals = (f: Fixture) => ({ base: splitLines(f.base).finalNewline, mine: splitLines(f.mine).finalNewline, theirs: splitLines(f.theirs).finalNewline });
const versions = (f: Fixture) => [f.base, f.mine, f.theirs].map((t) => splitLines(t).lines);

describe('blocs tirés de git merge-file --diff3', () => {
  for (const f of fixtures as Fixture[]) {
    it(f.name, () => {
      const [base, mine, theirs] = versions(f);
      const chunks = parseMergeOutput(splitLines(f.expected).lines);
      expect(chunks).not.toBeNull();
      const blocks = blocksFromMergeOutput(chunks!, base, mine, theirs);
      expect(blocks).not.toBeNull();
      // Sans choix : exactement le texte de Git ; chaque version se retrouve entière.
      expect(composeResult(blocks!, new Map(), splitLines(f.mine).eol, finals(f))).toBe(f.expected);
      expect(blocks!.flatMap((b) => blockSide(b, 'base'))).toEqual(base);
      expect(blocks!.flatMap((b) => blockSide(b, 'mine'))).toEqual(mine);
      expect(blocks!.flatMap((b) => blockSide(b, 'theirs'))).toEqual(theirs);
      expect(blocks!.filter((b) => b.kind === 'conflict').length).toBe((f.expected.match(/^<{7} /gm) ?? []).length);
    });
  }

  it('l’exemple de la relecture a bien un conflit, que merge3 seul ne voit pas', () => {
    const f = (fixtures as Fixture[]).find((x) => x.name.startsWith('relecture'))!;
    const [base, mine, theirs] = versions(f);
    expect(merge3(base, mine, theirs).some((b) => b.kind === 'conflict')).toBe(false);
    const blocks = blocksFromMergeOutput(parseMergeOutput(splitLines(f.expected).lines)!, base, mine, theirs)!;
    expect(blocks.filter((b) => b.kind === 'conflict')).toHaveLength(1);
  });

  it('sortie incohérente avec les versions : null', () => {
    expect(blocksFromMergeOutput([{ mine: ['absent'], base: [], theirs: [] }], ['a'], ['a'], ['a'])).toBeNull();
  });
});

describe('parseMergeOutput', () => {
  it('texte et conflit diff3', () => {
    expect(parseMergeOutput(['a', '<<<<<<< m', 'x', '||||||| b', 'o', '=======', 'y', '>>>>>>> t', 'z'])).toEqual([
      { text: ['a'] },
      { mine: ['x'], base: ['o'], theirs: ['y'] },
      { text: ['z'] },
    ]);
  });
  it('taille de marqueur : les séries plus courtes sont du contenu', () => {
    const out = ['<<<<<<<<<< m', '=======', '||||||||||', '>>>>>>>', '==========', 'y', '>>>>>>>>>> t'];
    expect(parseMergeOutput(out, 10)).toEqual([{ mine: ['======='], base: ['>>>>>>>'], theirs: ['y'] }]);
  });
  it('sortie mal formée', () => {
    expect(parseMergeOutput(['<<<<<<< m', 'x'])).toBeNull();
    expect(parseMergeOutput(['=======', 'x'])).toBeNull();
    expect(parseMergeOutput(['<<<<<<< m', '<<<<<<< m', '=======', '>>>>>>> t'])).toBeNull();
  });
  it('markerSize dépasse la plus longue série du contenu', () => {
    expect(markerSize(['a\nb\n'])).toBe(7);
    expect(markerSize(['a\n=======\n', '<<<<<<<<<< x\n'])).toBe(11);
  });
});

describe('saut de ligne final', () => {
  const blocks: MergeBlock[] = [{ kind: 'same', lines: ['a'] }, { kind: 'conflict', base: ['b'], mine: ['M'], theirs: ['T'] }];
  const f = { base: false, mine: false, theirs: true }; // seule leur version a un saut final
  it('gardé quand on choisit leur version', () => {
    expect(composeResult(blocks, new Map([[1, 'theirs']]), '\n', f)).toBe('a\nT\n');
    expect(composeResult(blocks, new Map([[1, 'mine-theirs']]), '\n', f)).toBe('a\nM\nT\n');
    expect(composeResult(blocks, new Map([[1, 'mine']]), '\n', f)).toBe('a\nM');
    expect(composeResult(blocks, new Map([[1, 'base']]), '\n', f)).toBe('a\nb');
  });
  it('sans conflit : le côté qui l’a changé l’emporte', () => {
    const same: MergeBlock[] = [{ kind: 'same', lines: ['a'] }];
    expect(composeResult(same, new Map(), '\n', { base: false, mine: false, theirs: true })).toBe('a\n');
    expect(composeResult(same, new Map(), '\n', { base: true, mine: false, theirs: true })).toBe('a');
    expect(composeResult([{ kind: 'theirs', base: ['b'], lines: ['T'] }], new Map(), '\n', f)).toBe('T\n');
  });
});

describe('normalizeConflictText', () => {
  it('retire les étiquettes, garde les fins de ligne', () => {
    expect(normalizeConflictText('a\r\n<<<<<<< HEAD\r\nx\r\n||||||| parent de abc\r\n=======\r\n>>>>>>> 1234 (sujet)\r\n')).toBe(
      'a\r\n<<<<<<<\r\nx\r\n|||||||\r\n=======\r\n>>>>>>>\r\n',
    );
    expect(normalizeConflictText('<<<<<<<< pas un marqueur\n')).toBe('<<<<<<<< pas un marqueur\n');
  });
});
