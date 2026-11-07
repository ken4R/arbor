import { describe, expect, it } from 'vitest';
import type { Branch, Commit, RepoSnapshot, Tag } from '../../shared/types';
import { EMPTY_COMMAND_CONTEXT, type AppHooks } from '../commands';
import { buildDynamicCommands, GROUP_BRANCHES, GROUP_FILES, GROUP_RECENT, GROUP_TAGS } from './git';

const branch = (name: string, extra: Partial<Branch> = {}): Branch => ({ name, sha: 'a', current: false, remote: false, upstream: null, ...extra });
const commit = (sha: string, refs: Commit['refs'] = []): Commit => ({ sha, parents: [], author: 'A', email: 'a@x', date: 0, subject: sha, body: '', refs });
const tag = (name: string, sha: string | null): Tag => ({ name, sha, annotated: false, subject: '', date: 0 });

function snapshot(over: Partial<RepoSnapshot> = {}, status: Partial<RepoSnapshot['status']> = {}): RepoSnapshot {
  return {
    path: '/depots/arbor',
    name: 'arbor',
    commits: [],
    branches: [],
    tags: [],
    remotes: [{ name: 'origin', fetchUrl: 'https://exemple.org/arbor.git', pushUrl: 'https://exemple.org/arbor.git' }],
    stashes: [],
    head: 'a',
    ...over,
    status: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [], state: 'clean', ...status },
  };
}

const titles = (snap: RepoSnapshot | null, group: string, recents: string[] = [], current?: string | null) =>
  buildDynamicCommands(snap, recents, current).filter((c) => c.group === group).map((c) => c.title);

describe('buildDynamicCommands', () => {
  it('branches : ni la courante, ni origin/HEAD, ni son upstream, ni distant/<branche courante>', () => {
    const snap = snapshot({
      branches: [
        branch('main', { current: true, upstream: 'origin/main' }),
        branch('feature/api'),
        branch('origin/HEAD', { remote: true }),
        branch('origin/main', { remote: true }),
        branch('upstream/main', { remote: true }),
        branch('origin/feature/api', { remote: true }),
      ],
    });
    expect(titles(snap, GROUP_BRANCHES)).toEqual(['Checkout feature/api', 'Checkout origin/feature/api']);
  });

  it('upstream d’un autre nom que la branche courante : écarté aussi', () => {
    const snap = snapshot(
      { branches: [branch('dev', { current: true, upstream: 'origin/develop' }), branch('origin/develop', { remote: true })] },
      { branch: 'dev' },
    );
    expect(titles(snap, GROUP_BRANCHES)).toEqual([]);
  });

  it('tags : seulement ceux dont le commit est chargé dans le graphe', () => {
    const snap = snapshot({
      tags: [tag('v1.0', 'c1'), tag('v0.1-ancien', 'c0'), tag('arbre', null), tag('v2.0', 'c2')],
      commits: [commit('c2', [{ name: 'v2.0', type: 'tag' }]), commit('c1', [{ name: 'v1.0', type: 'tag' }, { name: 'main', type: 'local' }])],
    });
    const cmds = buildDynamicCommands(snap, []).filter((c) => c.group === GROUP_TAGS);
    // v0.1-ancien pointe au-delà des commits chargés, « arbre » ne vise pas un commit : écartés.
    expect(cmds.map((c) => c.title)).toEqual(['Aller au tag v1.0', 'Aller au tag v2.0']);
    let selected = '';
    const app: AppHooks = { ...EMPTY_COMMAND_CONTEXT.app, selectCommit: (sha) => void (selected = sha) };
    cmds[0].run({ ...EMPTY_COMMAND_CONTEXT, app });
    expect(selected).toBe('c1');
  });

  it('fichier indexé ET modifié : deux entrées aux ids distincts', () => {
    const snap = snapshot({}, { staged: [{ path: 'a.ts', status: 'M' }], unstaged: [{ path: 'a.ts', status: 'M' }, { path: 'neuf.ts', status: '?' }] });
    const files = buildDynamicCommands(snap, []).filter((c) => c.group === GROUP_FILES);
    expect(files.map((c) => [c.title, c.keywords])).toEqual([
      ['a.ts', ['indexé']],
      ['a.ts', ['modifié']],
      ['neuf.ts', ['non suivi']],
    ]);
    expect(new Set(files.map((c) => c.id)).size).toBe(files.length);
  });

  it('dépôts récents : sans le dépôt courant, dossier parent ajouté aux noms en double', () => {
    const recents = ['/depots/arbor', '/home/moi/site', '/travail/site', '/travail/outil'];
    expect(titles(snapshot(), GROUP_RECENT, recents)).toEqual(['Ouvrir site (moi)', 'Ouvrir site (travail)', 'Ouvrir outil']);
    // Pendant le chargement (pas d'instantané), le dépôt courant est donné explicitement.
    expect(titles(null, GROUP_RECENT, recents, '/travail/outil')).toEqual(['Ouvrir arbor', 'Ouvrir site (moi)', 'Ouvrir site (travail)']);
  });

  it('ids tous distincts', () => {
    const snap = snapshot(
      {
        branches: [branch('main', { current: true }), branch('x'), branch('origin/x', { remote: true })],
        tags: [tag('x', 'c')],
        commits: [commit('c', [{ name: 'x', type: 'tag' }])],
      },
      { unstaged: [{ path: 'x', status: 'M' }] },
    );
    const cmds = buildDynamicCommands(snap, ['/a/x', '/b/x']);
    expect(new Set(cmds.map((c) => c.id)).size).toBe(cmds.length);
  });
});
