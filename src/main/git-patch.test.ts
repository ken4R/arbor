// Indexation partielle sur un vrai dépôt temporaire : la configuration de l'utilisateur ne doit pas fausser le patch.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffTarget, PatchAction } from '../shared/types';
import { applyPatchSelection, diff } from './git';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Dépôt avec `config.json` et `src/config.json` identiques au départ, puis `src/config.json` modifié. */
function repo(config: [string, string][], rootContent = '{\n  "a": 1\n}\n') {
  const dir = mkdtempSync(join(tmpdir(), 'arbor-patch-'));
  dirs.push(dir);
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  sh('init', '-q');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'user.name', 'Test');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'config.json'), rootContent);
  writeFileSync(join(dir, 'src/config.json'), '{\n  "a": 1\n}\n');
  sh('add', '.');
  sh('commit', '-qm', 'base');
  for (const [k, v] of config) sh('config', k, v);
  writeFileSync(join(dir, 'src/config.json'), '{\n  "a": 2\n}\n');
  return { dir, sh, read: (p: string) => readFileSync(join(dir, p), 'utf8') };
}

const target: DiffTarget = { kind: 'working', path: 'src/config.json', staged: false };

describe('applyPatchSelection', () => {
  it('indexe le bon fichier malgré diff.noprefix', async () => {
    const r = repo([['diff.noprefix', 'true']]);
    const raw = await diff(r.dir, target);
    expect(raw).toContain('--- a/src/config.json');
    await applyPatchSelection(r.dir, target, raw, [{ hunk: 0 }], 'stage');
    expect(r.sh('diff', '--cached', '--name-only')).toBe('src/config.json\n');
    expect(r.sh('status', '--porcelain')).toBe('M  src/config.json\n');
  });

  it('annule dans le bon fichier malgré diff.noprefix', async () => {
    // config.json à la racine contient déjà la version « 2 » : un patch mal ciblé s'y appliquerait en sens inverse.
    const r = repo([['diff.noprefix', 'true']], '{\n  "a": 2\n}\n');
    const raw = await diff(r.dir, target);
    await applyPatchSelection(r.dir, target, raw, [{ hunk: 0 }], 'discard');
    expect(r.read('src/config.json')).toBe('{\n  "a": 1\n}\n');
    expect(r.read('config.json')).toBe('{\n  "a": 2\n}\n');
    expect(r.sh('status', '--porcelain')).toBe('');
  });

  it('ignore color.ui=always, diff.mnemonicPrefix et les textconv', async () => {
    const r = repo([
      ['color.ui', 'always'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.maj.textconv', 'tr a-z A-Z <'],
    ]);
    writeFileSync(join(r.dir, '.git/info/attributes'), '*.json diff=maj\n');
    const raw = await diff(r.dir, target);
    expect(raw).not.toContain('\x1b[');
    expect(raw).toContain('+  "a": 2');
    await applyPatchSelection(r.dir, target, raw, [{ hunk: 0 }], 'stage');
    expect(r.sh('status', '--porcelain')).toBe('M  src/config.json\n');
  });

  it('refuse une action inconnue', async () => {
    const r = repo([]);
    const raw = await diff(r.dir, target);
    await expect(applyPatchSelection(r.dir, target, raw, [{ hunk: 0 }], 'reset' as PatchAction)).rejects.toThrow('Action inconnue');
    expect(r.sh('status', '--porcelain')).toBe(' M src/config.json\n');
  });
});
