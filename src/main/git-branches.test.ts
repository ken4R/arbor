// Actions de glisser-déposer sur un vrai dépôt temporaire (aucun réseau : le remote est un dépôt nu local).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fastForwardBranch, mergeInto, moveBranch, pushBranch, rebaseBranch, translateGitError } from './git';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * Dépôt : `main` (base, m1) ; `devant` = main + d1 ; `diverge` = base + x1 ; extraite : `main`.
 */
function repo() {
  const dir = tmp('arbor-branches-');
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (file: string, msg: string) => {
    writeFileSync(join(dir, file), msg + '\n');
    sh('add', '--', file);
    sh('commit', '-q', '-m', msg);
  };
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'user.name', 'Test');
  commit('base.txt', 'base');
  sh('branch', 'diverge');
  commit('m1.txt', 'm1');
  sh('branch', 'derriere');
  sh('checkout', '-q', '-b', 'devant');
  commit('d1.txt', 'd1');
  sh('checkout', '-q', 'diverge');
  commit('x1.txt', 'x1');
  sh('checkout', '-q', 'main');
  const rev = (r: string) => sh('rev-parse', r);
  return { dir, sh, rev, commit };
}

describe('fastForwardBranch', () => {
  it('avance une branche non extraite sans checkout, inscrit au reflog', async () => {
    const { dir, sh, rev } = repo();
    const old = rev('derriere');
    await fastForwardBranch(dir, 'derriere', old, 'refs/heads/devant', rev('devant'));
    expect(rev('derriere')).toBe(rev('devant'));
    expect(sh('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(sh('reflog', '-1', '--format=%gs', 'refs/heads/derriere')).toBe('merge devant: Fast-forward');
  });

  it("refuse quand il n'y a pas d'avance rapide", async () => {
    const { dir, rev } = repo();
    await expect(fastForwardBranch(dir, 'diverge', rev('diverge'), 'refs/heads/devant', rev('devant'))).rejects.toThrow(/Pas d'avance rapide possible/);
    await expect(fastForwardBranch(dir, 'devant', rev('devant'), 'refs/heads/derriere', rev('derriere'))).rejects.toThrow(/contient déjà/);
  });

  it("refuse si la branche a changé depuis l'affichage", async () => {
    const { dir, rev } = repo();
    await expect(fastForwardBranch(dir, 'derriere', rev('diverge'), 'refs/heads/devant', rev('devant'))).rejects.toThrow(/a changé depuis l'affichage/);
    expect(rev('derriere')).toBe(rev('main'));
  });

  it('refuse la branche courante et une branche extraite dans un autre worktree', async () => {
    const { dir, sh, rev } = repo();
    await expect(fastForwardBranch(dir, 'main', rev('main'), 'refs/heads/devant', rev('devant'))).rejects.toThrow(/branche courante/);
    const wt = join(tmp('arbor-branches-wt-'), 'wt');
    sh('worktree', 'add', '-q', wt, 'derriere');
    await expect(fastForwardBranch(dir, 'derriere', rev('derriere'), 'refs/heads/devant', rev('devant'))).rejects.toThrow(/extraite dans un autre worktree/);
  });

  it('refuse un nom invalide', async () => {
    const { dir, rev } = repo();
    await expect(fastForwardBranch(dir, '--force', rev('main'), 'refs/heads/devant', rev('devant'))).rejects.toThrow(/n'est pas un nom de branche valide/);
  });
});

describe('fastForwardBranch : source vérifiée', () => {
  it('refuse un nom court et une source qui a bougé depuis l’affichage', async () => {
    const { dir, rev } = repo();
    await expect(fastForwardBranch(dir, 'derriere', rev('derriere'), 'devant', rev('devant'))).rejects.toThrow(/référence de branche complète/);
    await expect(fastForwardBranch(dir, 'derriere', rev('derriere'), 'refs/heads/devant', rev('main'))).rejects.toThrow(/« devant » a changé/);
    expect(rev('derriere')).toBe(rev('main'));
  });

  it('tag homonyme : la branche est utilisée, pas le tag', async () => {
    const { dir, sh, rev } = repo();
    sh('tag', 'devant', 'diverge');
    await fastForwardBranch(dir, 'derriere', rev('derriere'), 'refs/heads/devant', rev('refs/heads/devant'));
    expect(rev('refs/heads/derriere')).toBe(rev('refs/heads/devant'));
  });
});

describe('mergeInto', () => {
  it('fusionne dans la branche courante, avec le message habituel de Git', async () => {
    const { dir, sh, rev } = repo();
    await mergeInto(dir, 'main', rev('main'), 'refs/heads/diverge', false);
    expect(sh('log', '-1', '--format=%s')).toBe("Merge branch 'diverge'");
    expect(sh('rev-parse', 'HEAD^2')).toBe(rev('diverge'));
  });

  it('refuse si la branche courante a changé (autre branche ou autre SHA)', async () => {
    const { dir, sh, rev } = repo();
    await expect(mergeInto(dir, 'devant', rev('devant'), 'refs/heads/diverge', false)).rejects.toThrow(/La branche courante a changé/);
    await expect(mergeInto(dir, 'main', rev('diverge'), 'refs/heads/diverge', false)).rejects.toThrow(/La branche courante a changé/);
    expect(sh('rev-list', '--count', 'main')).toBe('2');
  });

  it('bascule puis fusionne (message « into » hors de main)', async () => {
    const { dir, sh, rev } = repo();
    await mergeInto(dir, 'devant', rev('devant'), 'refs/heads/diverge', true);
    expect(sh('symbolic-ref', '--short', 'HEAD')).toBe('devant');
    expect(sh('log', '-1', '--format=%s')).toBe("Merge branch 'diverge' into devant");
  });

  it('tag homonyme de la source : la branche est fusionnée, pas le tag', async () => {
    const { dir, sh, rev } = repo();
    sh('tag', 'diverge', 'devant');
    await mergeInto(dir, 'main', rev('main'), 'refs/heads/diverge', false);
    expect(sh('rev-parse', 'HEAD^2')).toBe(rev('refs/heads/diverge'));
  });

  it('branche distante : message « remote-tracking branch »', async () => {
    const { dir, sh, rev } = repo();
    sh('update-ref', 'refs/remotes/o/diverge', 'diverge');
    await mergeInto(dir, 'main', rev('main'), 'refs/remotes/o/diverge', false);
    expect(sh('log', '-1', '--format=%s')).toBe("Merge remote-tracking branch 'o/diverge'");
  });
});

describe('rebaseBranch', () => {
  it('tag homonyme de la cible : rebase sur la branche', async () => {
    const { dir, sh, rev } = repo();
    sh('tag', 'devant', 'main~1');
    await rebaseBranch(dir, 'diverge', 'refs/heads/devant', false);
    expect(sh('rev-parse', 'diverge~1')).toBe(rev('refs/heads/devant'));
  });

  it('rebase une branche non courante, qui reste extraite à la fin', async () => {
    const { dir, sh, rev } = repo();
    await rebaseBranch(dir, 'diverge', 'refs/heads/devant', false);
    expect(sh('symbolic-ref', '--short', 'HEAD')).toBe('diverge');
    expect(sh('rev-parse', 'diverge~1')).toBe(rev('devant'));
  });

  it('sans autostash, refuse avec des modifications locales ; avec, les réapplique', async () => {
    const { dir, sh } = repo();
    writeFileSync(join(dir, 'base.txt'), 'modifié\n');
    await expect(rebaseBranch(dir, 'main', 'refs/heads/diverge', false)).rejects.toThrow(/modifications/);
    await rebaseBranch(dir, 'main', 'refs/heads/diverge', true);
    expect(sh('status', '--porcelain')).toBe('M base.txt');
    expect(sh('rev-parse', 'main~1')).toBe(sh('rev-parse', 'diverge'));
  });

  it('refuse pendant une opération en cours', async () => {
    const { dir, sh, commit } = repo();
    commit('x1.txt', 'conflit');
    try {
      sh('merge', 'diverge');
    } catch {
      // conflit attendu
    }
    await expect(rebaseBranch(dir, 'devant', 'refs/heads/main', false)).rejects.toThrow(/opération est en cours/);
  });
});

describe('moveBranch', () => {
  it('déplace une branche non courante sur un commit quelconque', async () => {
    const { dir, sh, rev } = repo();
    await moveBranch(dir, 'devant', rev('devant'), rev('diverge'));
    expect(rev('devant')).toBe(rev('diverge'));
    expect(sh('reflog', '-1', '--format=%gs', 'refs/heads/devant')).toBe('branch: déplacée par Arbor');
  });

  it('refuse la branche courante, un SHA attendu périmé et une révision qui n’est pas un SHA', async () => {
    const { dir, rev } = repo();
    await expect(moveBranch(dir, 'main', rev('main'), rev('devant'))).rejects.toThrow(/branche courante/);
    await expect(moveBranch(dir, 'devant', rev('main'), rev('diverge'))).rejects.toThrow(/a changé/);
    await expect(moveBranch(dir, 'devant', rev('devant'), 'HEAD~1')).rejects.toThrow(/identifiant de commit/);
  });
});

describe('pushBranch', () => {
  it('pousse une branche non courante vers un dépôt nu, avec -u', async () => {
    const { dir, sh, rev } = repo();
    const bare = tmp('arbor-branches-bare-');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    sh('remote', 'add', 'nu', bare);
    await pushBranch(dir, 'nu', 'devant', true);
    expect(execFileSync('git', ['rev-parse', 'refs/heads/devant'], { cwd: bare, encoding: 'utf8' }).trim()).toBe(rev('devant'));
    expect(sh('rev-parse', '--abbrev-ref', 'devant@{upstream}')).toBe('nu/devant');
    await pushBranch(dir, 'nu', 'diverge', false);
    // Sans -u : aucune branche distante configurée (`git config` sort en erreur sur une clé absente).
    expect(() => sh('config', '--get', 'branch.diverge.remote')).toThrow();
  });

  it('refuse un remote inconnu (ou une URL)', async () => {
    const { dir } = repo();
    await expect(pushBranch(dir, '/tmp/ailleurs', 'devant', false)).rejects.toThrow(/n'existe pas/);
  });
});

describe('traduction des erreurs de worktree', () => {
  it('reconnaît une branche extraite ailleurs', () => {
    expect(translateGitError("fatal: 'x' is already used by worktree at '/tmp/wt'")).toContain('/tmp/wt');
    expect(translateGitError("fatal: 'x' is already checked out at '/tmp/wt'")).toContain('autre worktree');
  });
});
