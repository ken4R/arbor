import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyReflog, parseReflog, reflog, reset, translateGitError, undoInfo, undoLabel, undoLast, undoPlan } from './git';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const US = '\x1f';

describe('classifyReflog', () => {
  it.each([
    ['commit: Ajoute la page', 'commit'],
    ['commit (initial): premier', 'commit'],
    ['commit (amend): Ajoute la page (corrigé)', 'amend'],
    ['commit (merge): Merge branch \'x\'', 'merge'],
    ['commit (cherry-pick): b', 'cherry-pick'],
    ['merge feature/x: Fast-forward', 'merge'],
    ["merge x: Merge made by the 'ort' strategy.", 'merge'],
    ['pull: Fast-forward', 'pull'],
    ['pull --rebase (finish): refs/heads/main onto 1234abcd', 'pull'],
    ['pull origin main: Merge made by the \'ort\' strategy.', 'pull'],
    [`rebase (finish): refs/heads/x onto ${A}`, 'rebase'],
    [`rebase -i (finish): refs/heads/x onto ${A}`, 'rebase'],
    [`rebase finished: refs/heads/x onto ${A}`, 'rebase'],
    ['reset: moving to HEAD~1', 'reset'],
    ['cherry-pick: b', 'cherry-pick'],
    ['revert: Revert "b"', 'revert'],
    ['checkout: moving from main to x', 'checkout'],
    ['branch: Created from HEAD', 'other'],
    ['Branch: renamed refs/heads/a to refs/heads/b', 'other'],
    ['', 'other'],
  ])('« %s » → %s', (subject, kind) => {
    expect(classifyReflog(subject)).toBe(kind);
  });
});

describe('parseReflog', () => {
  it('lit sha, date de l’opération et message, et numérote à partir de skip', () => {
    const out = `${A}${US}main@{1794144259}${US}commit (amend): accentué é${US}fin\0${B}${US}main@{1794144200}${US}branch: Created from HEAD\0`;
    expect(parseReflog(out, 'main', 3)).toEqual([
      { index: 3, selector: 'main@{3}', sha: A, subject: `commit (amend): accentué é${US}fin`, kind: 'amend', date: 1794144259 },
      { index: 4, selector: 'main@{4}', sha: B, subject: 'branch: Created from HEAD', kind: 'other', date: 1794144200 },
    ]);
  });

  it('sortie vide ou illisible : aucune entrée', () => {
    expect(parseReflog('', 'HEAD')).toEqual([]);
    expect(parseReflog('n importe quoi\0\n', 'HEAD')).toEqual([]);
  });

  it('message vide et date absente', () => {
    expect(parseReflog(`${A}${US}HEAD@{0}${US}\0`, 'HEAD')).toEqual([{ index: 0, selector: 'HEAD@{0}', sha: A, subject: '', kind: 'other', date: 0 }]);
  });
});

describe('undoLabel', () => {
  it('raccourcit les messages longs', () => {
    expect(undoLabel('commit: court')).toBe('commit: court');
    const long = `rebase (finish): refs/heads/feature/historique onto ${A}`;
    const label = undoLabel(long);
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('undoPlan', () => {
  const e = (sha: string, subject: string) => ({ sha, subject });

  it('commit et amend : reset --soft vers l’entrée précédente', () => {
    expect(undoPlan([e(B, 'commit: deux'), e(A, 'commit (initial): un')], B, 'main')).toEqual({
      plan: { kind: 'commit', label: 'commit: deux', target: A, mode: 'soft' },
      reason: null,
    });
    expect(undoPlan([e(B, 'commit (amend): deux'), e(A, 'commit: deux')], B, 'main').plan).toMatchObject({ kind: 'amend', mode: 'soft', target: A });
  });

  it.each([
    [`rebase (finish): refs/heads/x onto ${C}`, 'rebase'],
    [`rebase -i (finish): refs/heads/x onto ${C}`, 'rebase'],
    ['pull: Fast-forward', 'pull'],
    ['reset: moving to HEAD~1', 'reset'],
    ['merge x: Fast-forward', 'merge'],
    ['commit (merge): Merge branch x', 'merge'],
    ['cherry-pick: b', 'cherry-pick'],
    ['revert: Revert "b"', 'revert'],
  ])('« %s » : reset --keep', (subject, kind) => {
    expect(undoPlan([e(B, subject), e(A, 'commit: un')], B, 'main').plan).toMatchObject({ kind, mode: 'keep', target: A });
  });

  it('première entrée (création de la branche, commit initial) : rien à annuler', () => {
    const r = undoPlan([e(A, 'branch: Created from HEAD')], A, 'x');
    expect(r.plan).toBeNull();
    expect(r.reason).toMatch(/premier état/);
    expect(undoPlan([e(A, 'commit (initial): un')], A, 'main').reason).toMatch(/premier état/);
  });

  it('refuse HEAD détachée, dépôt vide, reflog vide ou désaccordé', () => {
    expect(undoPlan([e(B, 'commit: x'), e(A, 'commit: y')], B, null).reason).toMatch(/HEAD détachée/);
    expect(undoPlan([], null, 'main').reason).toMatch(/Dépôt vide/);
    expect(undoPlan([], A, 'main').reason).toMatch(/vide/);
    expect(undoPlan([e(B, 'commit: x'), e(A, 'commit: y')], C, 'main').reason).toMatch(/ne correspond pas/);
  });

  it('refuse les opérations non classées et celles qui n’ont pas déplacé la branche', () => {
    expect(undoPlan([e(B, 'branch: Reset to v1'), e(A, 'commit: y')], B, 'main').reason).toMatch(/ne s'annule pas/);
    expect(undoPlan([e(A, 'reset: moving to HEAD'), e(A, 'commit: y')], A, 'main').reason).toMatch(/pas déplacé/);
  });
});

describe('translateGitError (reflog)', () => {
  it('traduit le refus de reset --keep', () => {
    const raw = "error: Entry 'a.txt' not uptodate. Cannot merge.\nfatal: Could not reset index file to revision 'abc'.";
    expect(translateGitError(raw)).toMatch(/« a\.txt » a des modifications locales/);
  });
});

describe('reflog et annulation sur un vrai dépôt', () => {
  let dir = '';
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const commitFile = (file: string, content: string, msg: string) => {
    writeFileSync(join(dir, file), content);
    g('add', '-A');
    g('commit', '-qm', msg);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'arbor-reflog-'));
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'T');
    g('config', 'user.email', 't@x');
    commitFile('a.txt', 'un\n', 'un');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('annule un commit : la branche recule, les changements restent indexés', async () => {
    const before = g('rev-parse', 'HEAD');
    commitFile('b.txt', 'b\n', 'ajoute b');
    const info = await undoInfo(dir);
    expect(info.plan).toMatchObject({ kind: 'commit', mode: 'soft', target: before, label: 'commit: ajoute b' });
    await undoLast(dir, info.head!, info.plan!.target);
    expect(g('rev-parse', 'HEAD')).toBe(before);
    expect(g('status', '--porcelain')).toBe('A  b.txt');
    // Annuler à nouveau (entrée « reset ») rétablit le commit : l'index correspond déjà à sa version.
    const redo = await undoInfo(dir);
    expect(redo.plan).toMatchObject({ kind: 'reset', mode: 'keep' });
    await undoLast(dir, redo.head!, redo.plan!.target);
    expect(g('log', '-1', '--format=%s')).toBe('ajoute b');
    expect(g('status', '--porcelain')).toBe('');
    g('reset', '-q', '--soft', 'HEAD~1');
    g('commit', '-qm', 'ajoute b');
  });

  it('annule un rebase : la branche revient à son état d’avant (reset --keep)', async () => {
    g('checkout', '-qb', 'x', 'HEAD~1');
    commitFile('c.txt', 'c\n', 'ajoute c');
    const beforeRebase = g('rev-parse', 'HEAD');
    g('rebase', '-q', 'main');
    const info = await undoInfo(dir);
    expect(info.branch).toBe('x');
    expect(info.plan).toMatchObject({ kind: 'rebase', mode: 'keep', target: beforeRebase });
    await undoLast(dir, info.head!, info.plan!.target);
    expect(g('rev-parse', 'HEAD')).toBe(beforeRebase);
    expect(g('status', '--porcelain')).toBe('');
    // L'annulation est elle-même une entrée « reset » : Annuler à nouveau rétablit le rebase.
    const again = await undoInfo(dir);
    expect(again.plan).toMatchObject({ kind: 'reset', mode: 'keep' });
  });

  it('refuse une annulation périmée et une branche juste créée', async () => {
    const info = await undoInfo(dir);
    await expect(undoLast(dir, 'f'.repeat(40), info.plan!.target)).rejects.toThrow(/a changé/);
    g('checkout', '-qb', 'neuve');
    const fresh = await undoInfo(dir);
    expect(fresh.plan).toBeNull();
    expect(fresh.reason).toMatch(/premier état/);
    await expect(undoLast(dir, fresh.head!, fresh.head!)).rejects.toThrow(/premier état/);
    g('checkout', '-q', 'x');
  });

  it('refuse en HEAD détachée et pendant une opération', async () => {
    g('checkout', '-q', '--detach');
    expect((await undoInfo(dir)).reason).toMatch(/HEAD détachée/);
    g('checkout', '-q', 'x');
    writeFileSync(join(dir, '.git', 'MERGE_HEAD'), `${g('rev-parse', 'main')}\n`);
    expect((await undoInfo(dir)).reason).toMatch(/opération est en cours/);
    await expect(reset(dir, g('rev-parse', 'HEAD~1'), 'keep')).rejects.toThrow(/opération est en cours/);
    rmSync(join(dir, '.git', 'MERGE_HEAD'));
  });

  it('reset --keep refuse d’écraser un fichier non suivi ou une modification locale', async () => {
    const info = await undoInfo(dir); // annulation du reset : revient au rebase, qui ajoute b.txt
    writeFileSync(join(dir, 'b.txt'), 'non suivi\n');
    await expect(undoLast(dir, info.head!, info.plan!.target)).rejects.toThrow(/non suivi « b\.txt » serait écrasé/);
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('non suivi\n');
    rmSync(join(dir, 'b.txt'));

    commitFile('c.txt', 'c modifié\n', 'modifie c');
    g('reset', '-q', '--hard', 'HEAD~1');
    const undoReset = await undoInfo(dir);
    expect(undoReset.plan).toMatchObject({ kind: 'reset', mode: 'keep' });
    writeFileSync(join(dir, 'c.txt'), 'local\n');
    await expect(undoLast(dir, undoReset.head!, undoReset.plan!.target)).rejects.toThrow(/« c\.txt » a des modifications locales/);
    expect(readFileSync(join(dir, 'c.txt'), 'utf8')).toBe('local\n');
    g('checkout', '--', 'c.txt');
  });

  it('liste le reflog d’une branche et de HEAD, par page, avec la date de l’opération', async () => {
    const list = await reflog(dir, 'x', 0);
    expect(list[0]).toMatchObject({ index: 0, selector: 'x@{0}', kind: 'reset', sha: g('rev-parse', 'x') });
    expect(list[list.length - 1].subject).toMatch(/^branch: Created from/);
    expect(list.every((r) => r.date > 1_000_000_000)).toBe(true);
    const page = await reflog(dir, 'x', 1);
    expect(page[0]).toMatchObject({ index: 1, selector: 'x@{1}', sha: list[1].sha });
    expect((await reflog(dir, 'HEAD', 0)).some((r) => r.kind === 'checkout')).toBe(true);
    expect(await reflog(dir, 'absente', 0)).toEqual([]);
    await expect(reflog(dir, '--all', 0)).rejects.toThrow(/valide/);
  });

  it('branche sans reflog (core.logAllRefUpdates=false) : liste vide, rien à annuler', async () => {
    g('-c', 'core.logAllRefUpdates=false', 'update-ref', 'refs/heads/sans-journal', 'HEAD');
    expect(await reflog(dir, 'sans-journal', 0)).toEqual([]);
    g('checkout', '-q', 'sans-journal');
    expect((await undoInfo(dir)).reason).toMatch(/reflog de « sans-journal » est vide/);
    g('checkout', '-q', 'x');
  });

  it('reset refuse un mode inconnu', async () => {
    await expect(reset(dir, g('rev-parse', 'HEAD'), 'merge' as 'keep')).rejects.toThrow(/Mode de reset inconnu/);
  });
});
