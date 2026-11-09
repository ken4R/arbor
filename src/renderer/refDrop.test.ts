import { describe, expect, it } from 'vitest';
import type { Branch, Commit, RepoSnapshot, RepoState } from '../shared/types';
import { dragDisabledReason, dropActions, type RefAction } from './refDrop';

const commit = (sha: string): Commit => ({ sha, parents: [], author: 'A', email: 'a@x', date: 0, subject: sha, body: '', refs: [] }) as Commit;
const br = (name: string, sha: string, extra: Partial<Branch> = {}): Branch => ({ name, sha, current: false, remote: false, upstream: null, ...extra });

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

/** `main` (courante, A), `feature` (B), `egal` (A), `origin/main` (A), `origin/feature` (C), remote `origin`. */
function snap(opts: { branch?: string | null; state?: RepoState; empty?: boolean } = {}): RepoSnapshot {
  const branch = opts.branch === undefined ? 'main' : opts.branch;
  return {
    path: '/depot',
    name: 'depot',
    commits: opts.empty ? [] : [commit(A), commit(B), commit(C)],
    branches: [
      br('main', A, { current: branch === 'main', upstream: 'origin/main' }),
      br('feature', B, { current: branch === 'feature' }),
      br('egal', A),
      br('origin/main', A, { remote: true }),
      br('origin/feature', C, { remote: true }),
      br('origin/HEAD', A, { remote: true }),
    ],
    tags: [],
    remotes: [{ name: 'origin', fetchUrl: '/r.git', pushUrl: null }],
    stashes: [],
    status: { branch, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [], state: opts.state ?? 'clean' },
    head: opts.empty ? null : A,
  } as RepoSnapshot;
}

const ids = (a: RefAction[]) => a.map((x) => x.id);
const enabled = (a: RefAction[]) => a.filter((x) => !x.disabledReason).map((x) => x.id);
const local = (name: string) => ({ name, remote: false });

describe('dropActions : branche sur branche', () => {
  it('sur la branche courante : fusionner, rebaser la source (non courante)', () => {
    const a = dropActions(snap(), local('feature'), { kind: 'branch', name: 'main', remote: false });
    expect(ids(a)).toEqual(['merge', 'rebase', 'checkoutRebaseInteractive']);
    expect(a[0].label).toBe('Fusionner « feature » dans « main »');
    expect(a[1].label).toContain('vous serez sur « feature » à la fin');
  });

  it('sur une branche non courante : avance rapide, basculer puis fusionner, rebase de la courante', () => {
    const a = dropActions(snap(), local('main'), { kind: 'branch', name: 'feature', remote: false });
    expect(ids(a)).toEqual(['fastForward', 'checkoutMerge', 'rebase', 'rebaseInteractive']);
    expect(a[0].label).toContain('sans checkout');
    expect(a[1].label).toContain('vous restez sur « feature »');
  });

  it('même branche : rien', () => {
    expect(dropActions(snap(), local('main'), { kind: 'branch', name: 'main', remote: false })).toEqual([]);
  });

  it('même commit : actions grisées avec la raison', () => {
    const a = dropActions(snap(), local('egal'), { kind: 'branch', name: 'main', remote: false });
    expect(a.length).toBeGreaterThan(0);
    expect(enabled(a)).toEqual([]);
    expect(a[0].disabledReason).toContain('même commit');
  });

  it('source distante : fusion et avance rapide, jamais de rebase', () => {
    const src = { name: 'origin/feature', remote: true };
    expect(ids(dropActions(snap(), src, { kind: 'branch', name: 'main', remote: false }))).toEqual(['merge']);
    expect(ids(dropActions(snap(), src, { kind: 'branch', name: 'feature', remote: false }))).toEqual(['fastForward', 'checkoutMerge']);
  });

  it('cible distante, source origin/HEAD ou branche inconnue : rien', () => {
    expect(dropActions(snap(), local('feature'), { kind: 'branch', name: 'origin/main', remote: true })).toEqual([]);
    expect(dropActions(snap(), { name: 'origin/HEAD', remote: true }, { kind: 'branch', name: 'feature', remote: false })).toEqual([]);
    expect(dropActions(snap(), local('disparue'), { kind: 'branch', name: 'main', remote: false })).toEqual([]);
  });

  it('HEAD détachée : seulement les actions « non courante »', () => {
    const a = dropActions(snap({ branch: null }), local('feature'), { kind: 'branch', name: 'main', remote: false });
    expect(ids(a)).toEqual(['fastForward', 'checkoutMerge', 'rebase', 'checkoutRebaseInteractive']);
  });
});

describe('dropActions : branche sur commit', () => {
  it('branche non courante : rebaser ou déplacer (destructif)', () => {
    const a = dropActions(snap(), local('feature'), { kind: 'commit', sha: C });
    expect(ids(a)).toEqual(['rebase', 'move']);
    expect(a[1].danger).toBe(true);
    expect(enabled(a)).toEqual(['rebase', 'move']);
  });

  it('branche courante : déplacer est grisé (renvoi aux resets)', () => {
    const a = dropActions(snap(), local('main'), { kind: 'commit', sha: B });
    expect(enabled(a)).toEqual(['rebase']);
    expect(a[1].disabledReason).toMatch(/reset/);
  });

  it('commit = HEAD de la branche : tout est grisé', () => {
    const a = dropActions(snap(), local('main'), { kind: 'commit', sha: A });
    expect(enabled(a)).toEqual([]);
  });

  it('branche distante sur un commit : rien', () => {
    expect(dropActions(snap(), { name: 'origin/feature', remote: true }, { kind: 'commit', sha: A })).toEqual([]);
  });
});

describe('dropActions : branche sur remote', () => {
  it('pousser une branche locale ; déjà à jour = grisé', () => {
    expect(enabled(dropActions(snap(), local('feature'), { kind: 'remote', name: 'origin' }))).toEqual(['push']);
    const a = dropActions(snap(), local('main'), { kind: 'remote', name: 'origin' });
    expect(a[0].disabledReason).toContain('déjà à jour');
  });

  it('source distante ou remote inconnu : rien', () => {
    expect(dropActions(snap(), { name: 'origin/main', remote: true }, { kind: 'remote', name: 'origin' })).toEqual([]);
    expect(dropActions(snap(), local('feature'), { kind: 'remote', name: 'miroir' })).toEqual([]);
  });
});

describe('dropActions : états du dépôt', () => {
  it('opération en cours : tout est grisé avec la raison', () => {
    const a = dropActions(snap({ state: 'merging' }), local('feature'), { kind: 'branch', name: 'main', remote: false });
    expect(a.length).toBeGreaterThan(0);
    expect(enabled(a)).toEqual([]);
    expect(a.every((x) => x.disabledReason?.includes('fusion'))).toBe(true);
  });

  it('dépôt vide : glisser désactivé', () => {
    const s = snap({ empty: true });
    expect(dragDisabledReason(s)).toMatch(/vide/);
    expect(dropActions(s, local('feature'), { kind: 'branch', name: 'main', remote: false })).toEqual([]);
    expect(dragDisabledReason(snap())).toBeNull();
  });
});
