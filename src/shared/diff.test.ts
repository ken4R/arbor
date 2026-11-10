import { describe, expect, it } from 'vitest';
import { parseDiff, parseSubmoduleChange } from './diff';

// Sorties réelles de git 2.43 avec `--submodule=short`.
const changedDirty = `diff --git a/vendor/lib b/vendor/lib
index 7b38535..56e6590 160000
--- a/vendor/lib
+++ b/vendor/lib
@@ -1 +1 @@
-Subproject commit 7b38535b1417aa5a65b8f56ba4a0bb2c3e4b88a4
+Subproject commit 56e6590f21e112de52eb6aad76830b5b1a2ff7bd-dirty
`;

const added = `diff --git a/vendor/lib b/vendor/lib
new file mode 160000
index 0000000..99dbb2f
--- /dev/null
+++ b/vendor/lib
@@ -0,0 +1 @@
+Subproject commit 99dbb2f1c9db5fcad9a0f88aaf1ea37dfc068d6a
`;

const removed = `diff --git a/vendor/outils b/vendor/outils
deleted file mode 160000
index 0430cb9..0000000
--- a/vendor/outils
+++ /dev/null
@@ -1 +0,0 @@
-Subproject commit 0430cb9d4e37f1943140842a25110b5af106b6de
`;

// Même commit, seulement des modifications non commitées dans le sous-module.
const dirtyOnly = `diff --git a/vendor/lib b/vendor/lib
--- a/vendor/lib
+++ b/vendor/lib
@@ -1 +1 @@
-Subproject commit 7b38535b1417aa5a65b8f56ba4a0bb2c3e4b88a4
+Subproject commit 7b38535b1417aa5a65b8f56ba4a0bb2c3e4b88a4-dirty
`;

describe('parseSubmoduleChange', () => {
  it('lit les deux commits et l’état « dirty »', () => {
    expect(parseSubmoduleChange(changedDirty)).toEqual({
      old: '7b38535b1417aa5a65b8f56ba4a0bb2c3e4b88a4',
      new: '56e6590f21e112de52eb6aad76830b5b1a2ff7bd',
      dirty: true,
    });
  });

  it('sous-module ajouté ou supprimé : un côté absent', () => {
    expect(parseSubmoduleChange(added)).toEqual({ old: null, new: '99dbb2f1c9db5fcad9a0f88aaf1ea37dfc068d6a', dirty: false });
    expect(parseSubmoduleChange(removed)).toEqual({ old: '0430cb9d4e37f1943140842a25110b5af106b6de', new: null, dirty: false });
  });

  it('ignore un fichier ordinaire, même s’il contient le texte « Subproject commit »', () => {
    const file = `diff --git a/notes.txt b/notes.txt
index 1111111..2222222 100644
--- a/notes.txt
+++ b/notes.txt
@@ -1 +1 @@
-Subproject commit 7b38535b1417aa5a65b8f56ba4a0bb2c3e4b88a4
+Subproject commit 56e6590f21e112de52eb6aad76830b5b1a2ff7bd
`;
    expect(parseSubmoduleChange(file)).toBeNull();
    expect(parseDiff(file).submodule).toBeUndefined();
  });

  it('sans ligne « index » (même commit, modifications seules) : reconnu par les lignes Subproject', () => {
    expect(parseSubmoduleChange(dirtyOnly)).toEqual({ old: '7b38535b1417aa5a65b8f56ba4a0bb2c3e4b88a4', new: '7b38535b1417aa5a65b8f56ba4a0bb2c3e4b88a4', dirty: true });
    // Changement de mode seul d'un fichier ordinaire : pas de bloc, pas de sous-module.
    expect(parseSubmoduleChange('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toBeNull();
    // Sans ligne « index » mais avec une ligne de contenu ordinaire : pas un sous-module.
    expect(parseSubmoduleChange(dirtyOnly.replace('+Subproject', '+autre chose\n+Subproject'))).toBeNull();
  });
});

describe('parseSubmoduleChange (changement de type)', () => {
  it('fichier → gitlink : seule la section du gitlink est lue', () => {
    const raw = `diff --git a/x b/x
deleted file mode 100644
index 1111111..0000000
--- a/x
+++ /dev/null
@@ -1 +0,0 @@
-Subproject commit 7b38535b1417aa5a65b8f56ba4a0bb2c3e4b88a4
${added.replace(/vendor\/lib/g, 'x')}`;
    expect(parseSubmoduleChange(raw)).toEqual({ old: null, new: '99dbb2f1c9db5fcad9a0f88aaf1ea37dfc068d6a', dirty: false, typeChange: true });
  });

  it('gitlink → fichier', () => {
    const raw = `${removed}diff --git a/vendor/outils b/vendor/outils
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/vendor/outils
@@ -0,0 +1 @@
+contenu
`;
    expect(parseSubmoduleChange(raw)).toEqual({ old: '0430cb9d4e37f1943140842a25110b5af106b6de', new: null, dirty: false, typeChange: true });
  });
});

describe('parseDiff (sous-module)', () => {
  it('ajoute `submodule` et garde les compteurs', () => {
    const d = parseDiff(changedDirty);
    expect(d.submodule).toEqual({ old: '7b38535b1417aa5a65b8f56ba4a0bb2c3e4b88a4', new: '56e6590f21e112de52eb6aad76830b5b1a2ff7bd', dirty: true });
    expect(d.binary).toBe(false);
    expect(d.hunks).toHaveLength(1);
    expect(parseDiff(added).newFile).toBe(true);
    expect(parseDiff(added).submodule?.old).toBeNull();
  });
});
