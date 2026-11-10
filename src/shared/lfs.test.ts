import { describe, expect, it } from 'vitest';
import {
  formatLfsSize,
  lfsPullArgs,
  lfsIncludeError,
  lfsPathsFromCheckAttr,
  lfsPatternError,
  lfsPointerChange,
  parseGitattributesLfs,
  parseLfsFiles,
  parseLfsFilesJson,
  parseLfsPointer,
  parseLfsVersion,
} from './lfs';

// Sorties réelles de git-lfs 3.4.1.
const OID_A = 'a6365daaa6b00938418b963b3862b8d40772ef43358a14252ec0d68e36e52dd6';
const OID_B = 'c86f210e0efad769d6ade6f924a85200be38917fa99e33b360aa24535716359b';
const OID_C = '405c8ba2c927413959ba97acc3faa99ba5de1dcff545f15bafda781068878fae';

describe('parseLfsVersion', () => {
  it('lit la version', () => {
    expect(parseLfsVersion('git-lfs/3.4.1 (GitHub; linux amd64; go 1.22.2)\n')).toBe('3.4.1');
    expect(parseLfsVersion('git-lfs/2.13.3 (GitHub; darwin arm64; go 1.16)')).toBe('2.13.3');
  });
  it('null si illisible', () => {
    expect(parseLfsVersion("git: 'lfs' is not a git command.")).toBeNull();
  });
});

describe('parseGitattributesLfs', () => {
  it('suivis, exclusions, guillemets ; ignore commentaires, macros et autres filtres', () => {
    const text = [
      '# commentaire filter=lfs',
      '[attr]binaire -diff -merge',
      '*.bin filter=lfs diff=lfs merge=lfs -text',
      'x.bin !filter !diff !merge text',
      'y.bin -filter',
      '"nom \\"cité\\" .iso" filter=lfs',
      '*.txt filter=autre',
      '*.c text',
      '',
    ].join('\r\n');
    expect(parseGitattributesLfs(text)).toEqual([
      { pattern: '*.bin', source: '.gitattributes', excluded: false },
      { pattern: 'x.bin', source: '.gitattributes', excluded: true },
      { pattern: 'y.bin', source: '.gitattributes', excluded: true },
      { pattern: 'nom "cité" .iso', source: '.gitattributes', excluded: false },
    ]);
  });
});

describe('parseLfsFiles / parseLfsFilesJson', () => {
  it('texte : * présent, - pointeur seul, chemins avec espaces et accents', () => {
    const out = `${OID_A} - assets/maquette.psd\n${OID_B} * é t"q.bin\nligne invalide\n`;
    expect(parseLfsFiles(out)).toEqual([
      { path: 'assets/maquette.psd', oid: OID_A, present: false, downloaded: null, size: null },
      { path: 'é t"q.bin', oid: OID_B, present: true, downloaded: null, size: null },
    ]);
  });
  it('JSON : checkout et taille', () => {
    const out = JSON.stringify({
      files: [
        { name: 'assets/maquette.psd', size: 50000, checkout: false, downloaded: false, oid_type: 'sha256', oid: OID_A, version: 'https://git-lfs.github.com/spec/v1' },
        { name: 'é t"q.bin', size: 5, checkout: true, downloaded: true, oid_type: 'sha256', oid: OID_B, version: 'https://git-lfs.github.com/spec/v1' },
      ],
    });
    expect(parseLfsFilesJson(out)).toEqual([
      { path: 'assets/maquette.psd', oid: OID_A, present: false, downloaded: false, size: 50000 },
      { path: 'é t"q.bin', oid: OID_B, present: true, downloaded: true, size: 5 },
    ]);
  });
  it('JSON : aucun fichier (files: null) ou sortie illisible', () => {
    expect(parseLfsFilesJson('{\n "files": null\n}\n')).toEqual([]);
    expect(parseLfsFilesJson(`${OID_A} * a.bin`)).toBeNull();
  });
});

describe('lfsPathsFromCheckAttr', () => {
  it('garde les chemins dont filter vaut lfs', () => {
    const out = 'notes.txt\0filter\0unspecified\0data/x.bin\0filter\0lfs\0é t.psd\0filter\0lfs\0a.c\0filter\0autre\0';
    expect(lfsPathsFromCheckAttr(out)).toEqual(['data/x.bin', 'é t.psd']);
    expect(lfsPathsFromCheckAttr('')).toEqual([]);
  });
});

describe('lfsPatternError', () => {
  it('accepte les motifs usuels', () => {
    for (const p of ['*.psd', 'assets/**/*.png', 'dir with space/*.mp4', 'f(1).bin']) expect(lfsPatternError(p)).toBeNull();
  });
  it('refuse vide, saut de ligne, option, commentaire, négation, espaces autour', () => {
    for (const p of ['', '   ', 'a\nb', 'a\rb', '-weird', '--json', '#x', '!x', ' a', 'a ', '[attr]bin', '"a b"', 42, null]) expect(lfsPatternError(p)).not.toBeNull();
  });
});

describe('lfsIncludeError', () => {
  it('accepte un chemin simple, refuse virgule, caractères de motif et préfixes spéciaux', () => {
    expect(lfsIncludeError('assets/maquette.psd')).toBeNull();
    expect(lfsIncludeError('dossier é/fichier (1).bin')).toBeNull();
    for (const p of ['a,b.bin', '*.bin', 'a?.bin', 'a[1].bin', 'a\\b', '!a', '#a', '', 'a\nb']) expect(lfsIncludeError(p)).not.toBeNull();
  });
});

describe('lfsPullArgs', () => {
  it('fichier à la racine : homonymes des sous-dossiers exclus', () => {
    expect(lfsPullArgs(['x.bin'])).toEqual([['--include=x.bin', '--exclude=*/**/x.bin']]);
  });
  it('chemin avec un dossier : déjà ancré, sans exclusion ; lancements séparés si les deux sont demandés', () => {
    expect(lfsPullArgs(['sub dir/é.bin'])).toEqual([['--include=sub dir/é.bin']]);
    expect(lfsPullArgs(['x.bin', 'sub/x.bin', 'y.bin'])).toEqual([
      ['--include=sub/x.bin'],
      ['--include=x.bin,y.bin', '--exclude=*/**/x.bin,*/**/y.bin'],
    ]);
  });
});

const pointer = (oid: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

describe('parseLfsPointer', () => {
  it('lit oid et taille', () => {
    expect(parseLfsPointer(pointer(OID_A, 50000))).toEqual({ oid: OID_A, size: 50000 });
  });
  it('tolère les extensions, refuse un autre texte', () => {
    expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${OID_B}\noid sha256:${OID_A}\nsize 1\n`)).toEqual({ oid: OID_A, size: 1 });
    expect(parseLfsPointer('bonjour\n')).toBeNull();
    expect(parseLfsPointer(`version https://exemple.org/v1\noid sha256:${OID_A}\nsize 1\n`)).toBeNull();
    expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n`)).toBeNull();
    expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID_A}\n`)).toBeNull();
  });
});

describe('lfsPointerChange', () => {
  it('fichier modifié (diff réel de git avec --no-textconv)', () => {
    const raw = [
      'diff --git a/data/modele.bin b/data/modele.bin',
      'index 4fc9a39..232bdb1 100644',
      '--- a/data/modele.bin',
      '+++ b/data/modele.bin',
      '@@ -1,3 +1,3 @@',
      ' version https://git-lfs.github.com/spec/v1',
      `-oid sha256:${OID_B}`,
      `+oid sha256:${OID_C}`,
      ' size 20000',
      '',
    ].join('\n');
    expect(lfsPointerChange(raw)).toEqual({ old: { oid: OID_B, size: 20000 }, new: { oid: OID_C, size: 20000 } });
  });
  it('nouveau fichier et fichier supprimé', () => {
    const added = [
      'diff --git a/x.bin b/x.bin',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/x.bin',
      '@@ -0,0 +1,3 @@',
      ...pointer(OID_A, 12)
        .trimEnd()
        .split('\n')
        .map((l) => `+${l}`),
      '',
    ].join('\n');
    expect(lfsPointerChange(added)).toEqual({ old: null, new: { oid: OID_A, size: 12 } });
    const removed = added.replace('new file mode', 'deleted file mode').replace(/^\+(?!\+\+)/gm, '-').replace('@@ -0,0 +1,3 @@', '@@ -1,3 +0,0 @@');
    expect(lfsPointerChange(removed)).toEqual({ old: { oid: OID_A, size: 12 }, new: null });
  });
  it('null pour un fichier ordinaire, un binaire, plusieurs fichiers ou un diff vide', () => {
    const text = 'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n';
    expect(lfsPointerChange(text)).toBeNull();
    expect(lfsPointerChange('diff --git a/x.bin b/x.bin\nindex 1..2 100644\nBinary files a/x.bin and b/x.bin differ\n')).toBeNull();
    expect(lfsPointerChange('')).toBeNull();
    const conversion = [
      'diff --git a/x.bin b/x.bin',
      'index 1..2 100644',
      '--- a/x.bin',
      '+++ b/x.bin',
      '@@ -1 +1,3 @@',
      '-contenu',
      ...pointer(OID_A, 7)
        .trimEnd()
        .split('\n')
        .map((l) => `+${l}`),
      '',
    ].join('\n');
    expect(lfsPointerChange(conversion)).toBeNull();
  });
});

describe('formatLfsSize', () => {
  it('octets, Ko, Mo avec virgule décimale', () => {
    expect(formatLfsSize(0)).toBe('0 octet');
    expect(formatLfsSize(512)).toBe('512 octets');
    expect(formatLfsSize(20000)).toBe('19,5 Ko');
    expect(formatLfsSize(21504)).toBe('21,0 Ko');
    expect(formatLfsSize(5 * 1024 * 1024)).toBe('5,0 Mo');
  });
});
