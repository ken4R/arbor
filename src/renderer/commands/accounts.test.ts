import { describe, expect, it } from 'vitest';
import type { AccountInfo, Remote, RepoSnapshot } from '../../shared/types';
import { buildAccountCommands, currentRemote, prefillForRemoteUrl, remoteHost } from './accounts';

const remote = (name: string, url: string | null): Remote => ({ name, fetchUrl: url, pushUrl: url });

function snapshot(remotes: Remote[], upstream: string | null = null): RepoSnapshot {
  return {
    path: '/depots/arbor',
    name: 'arbor',
    commits: [],
    branches: [],
    tags: [],
    remotes,
    stashes: [],
    head: 'a',
    status: { branch: 'main', upstream, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [], state: 'clean' },
  } as unknown as RepoSnapshot;
}

const account = (over: Partial<AccountInfo> = {}): AccountInfo => ({
  id: 'a1',
  provider: 'gitlab',
  instanceUrl: 'https://git.exemple.org',
  host: 'git.exemple.org',
  sshHosts: ['git.exemple.org'],
  login: 'alice',
  name: null,
  avatarUrl: null,
  scopes: ['api'],
  missingScopes: [],
  authMethod: 'pat',
  status: 'ok',
  secretUnreadable: false,
  persisted: true,
  addedAt: 1,
  validatedAt: 1,
  ...over,
});

describe('prefillForRemoteUrl', () => {
  it('devine le fournisseur', () => {
    expect(prefillForRemoteUrl('https://github.com/o/r.git')).toEqual({ choice: 'github' });
    expect(prefillForRemoteUrl('git@github.com:o/r.git')).toEqual({ choice: 'github' });
    expect(prefillForRemoteUrl('ssh://git@altssh.gitlab.com:443/g/r.git')).toEqual({ choice: 'gitlab-com' });
    expect(prefillForRemoteUrl('https://gitlab.com/g/s/r.git')).toEqual({ choice: 'gitlab-com' });
  });
  it('GitLab auto-hébergé : origine https, port web gardé, port SSH ignoré', () => {
    expect(prefillForRemoteUrl('https://u:secret@Git.Exemple.org:8443/g/r.git')).toEqual({ choice: 'gitlab-self', instanceUrl: 'https://git.exemple.org:8443' });
    expect(prefillForRemoteUrl('ssh://git@git.exemple.org:2222/g/r.git')).toEqual({ choice: 'gitlab-self', instanceUrl: 'https://git.exemple.org' });
    expect(prefillForRemoteUrl('git@git.exemple.org:g/r.git')).toEqual({ choice: 'gitlab-self', instanceUrl: 'https://git.exemple.org' });
  });
  it('http : boucle locale seulement, sinon https', () => {
    expect(prefillForRemoteUrl('http://127.0.0.1:5000/g/r.git')).toEqual({ choice: 'gitlab-self', instanceUrl: 'http://127.0.0.1:5000' });
    expect(prefillForRemoteUrl('http://git.exemple.org/g/r.git')).toEqual({ choice: 'gitlab-self', instanceUrl: 'https://git.exemple.org' });
  });
  it('locales et git:// : rien', () => {
    expect(prefillForRemoteUrl('/srv/depot.git')).toBeNull();
    expect(prefillForRemoteUrl('git://h/r')).toBeNull();
    expect(prefillForRemoteUrl(null)).toBeNull();
  });
});

describe('remoteHost', () => {
  it('hôte et port (sauf SSH)', () => {
    expect(remoteHost('http://127.0.0.1:5000/g/r.git')).toBe('127.0.0.1:5000');
    expect(remoteHost('ssh://git@h:2222/r')).toBe('h');
    expect(remoteHost('/x')).toBeNull();
  });
});

describe('currentRemote', () => {
  const remotes = [remote('amont', 'https://a/r'), remote('origin', 'https://o/r'), remote('forge', 'https://f/r')];
  it('upstream, puis origin, puis le premier', () => {
    expect(currentRemote(snapshot(remotes, 'forge/main'))?.name).toBe('forge');
    expect(currentRemote(snapshot(remotes, null))?.name).toBe('origin');
    expect(currentRemote(snapshot([remotes[0]], null))?.name).toBe('amont');
    expect(currentRemote(snapshot([], null))).toBeNull();
  });
});

describe('buildAccountCommands', () => {
  const titles = (snap: RepoSnapshot | null, accounts: AccountInfo[]) => buildAccountCommands(snap, accounts).map((c) => c.title);
  it('« Comptes… » toujours, même sans dépôt', () => {
    expect(titles(null, [])).toEqual(['Comptes…']);
  });
  it('« Connecter un compte pour <hôte> » si le remote courant n’en a pas', () => {
    const snap = snapshot([remote('origin', 'https://git.exemple.org/g/r.git')]);
    expect(titles(snap, [])).toEqual(['Comptes…', 'Connecter un compte pour git.exemple.org']);
    expect(titles(snap, [account()])).toEqual(['Comptes…']);
    expect(titles(snapshot([remote('origin', '/srv/r.git')]), [])).toEqual(['Comptes…']);
  });
});
