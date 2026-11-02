import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff';
import { buildPartialPatch } from './patch';

const head = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
`;

// Deux blocs : le premier remplace deux lignes, le second en ajoute une.
const raw =
  head +
  `@@ -1,5 +1,5 @@ titre
 un
-deux
-trois
+DEUX
+TROIS
 quatre
 cinq
@@ -20,3 +20,4 @@ fin
 vingt
 vingt et un
+nouvelle
 vingt-deux
`;

/** Indices dans `Hunk.lines` des lignes dont le texte est donné. */
const idx = (r: string, hunk: number, ...texts: string[]) =>
  texts.map((t) => parseDiff(r).hunks[hunk].lines.findIndex((l) => l.text === t && l.type !== 'ctx'));

describe('buildPartialPatch', () => {
  it('garde un bloc entier tel quel, dans les deux sens', () => {
    const expected = head + raw.split(head)[1].split('@@ -20')[0];
    expect(buildPartialPatch(raw, [{ hunk: 0 }], false)).toBe(expected);
    expect(buildPartialPatch(raw, [{ hunk: 0 }], true)).toBe(expected);
  });

  it('recalcule la position du second bloc quand le premier est absent', () => {
    expect(buildPartialPatch(raw, [{ hunk: 1 }], false)).toBe(head + '@@ -20,3 +20,4 @@ fin\n vingt\n vingt et un\n+nouvelle\n vingt-deux\n');
  });

  it('décale le bloc suivant selon les lignes retenues du précédent', () => {
    const lines = idx(raw, 0, 'DEUX');
    const p = buildPartialPatch(raw, [{ hunk: 0, lines }, { hunk: 1 }], false);
    // Bloc 1 : -0 +1 → le bloc 2 commence une ligne plus bas côté nouveau.
    expect(p).toContain('@@ -1,5 +1,6 @@ titre\n un\n deux\n trois\n+DEUX\n quatre\n cinq\n');
    expect(p).toContain('@@ -20,3 +21,4 @@ fin\n');
  });

  it('indexe un sous-ensemble de suppressions', () => {
    const p = buildPartialPatch(raw, [{ hunk: 0, lines: idx(raw, 0, 'trois') }], false);
    expect(p).toBe(head + '@@ -1,5 +1,4 @@ titre\n un\n deux\n-trois\n quatre\n cinq\n');
  });

  it('mélange suppression et ajout choisis', () => {
    const p = buildPartialPatch(raw, [{ hunk: 0, lines: idx(raw, 0, 'deux', 'DEUX') }], false);
    expect(p).toBe(head + '@@ -1,5 +1,5 @@ titre\n un\n-deux\n trois\n+DEUX\n quatre\n cinq\n');
  });

  it('en sens inverse, garde les ajouts non choisis en contexte et retire les suppressions non choisies', () => {
    const p = buildPartialPatch(raw, [{ hunk: 0, lines: idx(raw, 0, 'TROIS') }], true);
    expect(p).toBe(head + '@@ -1,4 +1,5 @@ titre\n un\n DEUX\n+TROIS\n quatre\n cinq\n');
  });

  it('en sens inverse, la position est calculée depuis le côté nouveau', () => {
    const p = buildPartialPatch(raw, [{ hunk: 0, lines: idx(raw, 0, 'deux') }, { hunk: 1 }], true);
    expect(p).toContain('@@ -1,6 +1,5 @@ titre\n un\n-deux\n DEUX\n TROIS\n quatre\n cinq\n');
    // Côté ancien : une ligne de plus dans le premier bloc.
    expect(p).toContain('@@ -21,3 +20,4 @@ fin\n');
  });

  it('gère un ajout pur dont le côté ancien devient vide', () => {
    const r = head + '@@ -3,0 +4,2 @@\n+a\n+b\n';
    expect(buildPartialPatch(r, [{ hunk: 0, lines: [1] }], false)).toBe(head + '@@ -3,0 +4,1 @@\n+b\n');
    // Sens inverse d'un remplacement dont on ne retire que l'ajout : côté ancien vide.
    const r2 = head + '@@ -3 +3 @@\n-x\n+y\n';
    expect(buildPartialPatch(r2, [{ hunk: 0, lines: [1] }], true)).toBe(head + '@@ -2,0 +3,1 @@\n+y\n');
  });

  it('refuse une sélection vide', () => {
    expect(() => buildPartialPatch(raw, [], false)).toThrow('Aucune ligne');
    expect(() => buildPartialPatch(raw, [{ hunk: 0, lines: [0] }], false)).toThrow('Aucune ligne');
    expect(() => buildPartialPatch(raw, [{ hunk: 5 }], false)).toThrow('Bloc introuvable');
  });

  describe('« \\ No newline at end of file »', () => {
    // Dernière ligne sans saut de ligne remplacée par une ligne qui en a un.
    const r = head + '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n';
    const [del, add] = [1, 3]; // la ligne « \ » occupe l'indice 2

    it('suit la ligne à laquelle il se rattache', () => {
      expect(parseDiff(r).hunks[0].lines[del].type).toBe('del');
      expect(parseDiff(r).hunks[0].lines[add].type).toBe('add');
      expect(buildPartialPatch(r, [{ hunk: 0, lines: [del] }], false)).toBe(head + '@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n');
      expect(buildPartialPatch(r, [{ hunk: 0 }], false)).toBe(r);
    });

    it('refuse une sélection incohérente', () => {
      expect(() => buildPartialPatch(r, [{ hunk: 0, lines: [add] }], false)).toThrow('indexez le bloc entier');
    });

    it('disparaît avec une ligne retirée', () => {
      expect(buildPartialPatch(r, [{ hunk: 0, lines: [add] }], true)).toBe(head + '@@ -1,1 +1,2 @@\n a\n+b\n');
    });
  });

  it('conserve les chemins avec espaces ou accents et retire les changements de mode', () => {
    const h = 'diff --git "a/dossier/caf\\303\\251 cr\\303\\250me.txt" "b/dossier/caf\\303\\251 cr\\303\\250me.txt"\nold mode 100644\nnew mode 100755\nindex 1..2\n--- "a/dossier/caf\\303\\251 cr\\303\\250me.txt"\n+++ "b/dossier/caf\\303\\251 cr\\303\\250me.txt"\n';
    const p = buildPartialPatch(h + '@@ -1 +1 @@\n-é\n+è\n', [{ hunk: 0 }], false);
    expect(p).toBe(h.replace('old mode 100644\nnew mode 100755\n', '') + '@@ -1,1 +1,1 @@\n-é\n+è\n');
  });

  it("n'applique un fichier créé ou supprimé qu'en entier", () => {
    const r = 'diff --git a/n b/n\nnew file mode 100644\nindex 0000000..1\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n';
    expect(parseDiff(r).newFile).toBe(true);
    expect(buildPartialPatch(r, [{ hunk: 0 }], true)).toBe(r);
    expect(() => buildPartialPatch(r, [{ hunk: 0, lines: [0] }], false)).toThrow('fichier entier');
  });

  it('aligne ses indices sur ceux de parseDiff, ligne de contexte vide comprise', () => {
    // Une ligne de contexte vide peut arriver sans espace initiale.
    const r = head + '@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n';
    const lines = parseDiff(r).hunks[0].lines;
    expect(lines.map((l) => l.type)).toEqual(['ctx', 'ctx', 'del', 'add']);
    expect(buildPartialPatch(r, [{ hunk: 0, lines: [3] }], false)).toBe(head + '@@ -1,3 +1,4 @@\n a\n \n b\n+B\n');
  });
});
