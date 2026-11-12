import { describe, expect, it } from 'vitest';
import { accountForCredential, matchAccount, missingScopes, PROVIDERS } from './accounts';
import { parseRemoteUrl } from './remoteUrl';
import type { AccountInfo } from './types';

function account(over: Partial<AccountInfo>): AccountInfo {
  return {
    id: 'a',
    provider: 'gitlab',
    instanceUrl: 'https://gitlab.com',
    host: 'gitlab.com',
    sshHosts: ['gitlab.com', 'altssh.gitlab.com'],
    login: 'alice',
    name: null,
    avatarUrl: null,
    scopes: ['api'],
    missingScopes: [],
    authMethod: 'pat',
    status: 'ok',
    persisted: true,
    addedAt: 100,
    validatedAt: 100,
    ...over,
  };
}

describe('PROVIDERS', () => {
  it('pages de création de jeton sur l’instance', () => {
    expect(PROVIDERS.github.tokenUrl('https://github.com')).toMatch(/^https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo/);
    expect(PROVIDERS.gitlab.tokenUrl('https://git.exemple.org/gitlab')).toMatch(/^https:\/\/git\.exemple\.org\/gitlab\/-\/user_settings\/personal_access_tokens\?/);
  });
});

describe('missingScopes', () => {
  it('GitHub classique', () => {
    expect(missingScopes('github', ['repo', 'read:org'])).toEqual([]);
    expect(missingScopes('github', ['read:org'])).toEqual(['repo']);
    expect(missingScopes('github', [])).toEqual(['repo']);
  });

  it('GitHub à permissions fines : scopes inconnus', () => {
    expect(missingScopes('github', null)).toEqual([]);
  });

  it('GitLab : api, ou read_api + write_repository', () => {
    expect(missingScopes('gitlab', ['api'])).toEqual([]);
    expect(missingScopes('gitlab', ['read_api', 'write_repository'])).toEqual([]);
    expect(missingScopes('gitlab', ['read_api'])).toEqual(['write_repository']);
    expect(missingScopes('gitlab', ['read_user'])).toEqual(['api']);
  });
});

describe('matchAccount', () => {
  const gl = account({ id: 'gl' });
  const local = account({ id: 'local', instanceUrl: 'http://127.0.0.1:5000', host: '127.0.0.1:5000', sshHosts: ['127.0.0.1'] });
  const self = account({ id: 'self', instanceUrl: 'https://git.exemple.org:8443/gitlab', host: 'git.exemple.org:8443', sshHosts: ['git.exemple.org'] });
  const all = [gl, local, self];

  it('https avec port', () => {
    expect(matchAccount(parseRemoteUrl('https://git.exemple.org:8443/gitlab/g/p.git'), all)?.id).toBe('self');
    expect(matchAccount(parseRemoteUrl('https://git.exemple.org/gitlab/g/p.git'), all)).toBeNull();
    expect(matchAccount(parseRemoteUrl('http://127.0.0.1:5000/g/p.git'), all)?.id).toBe('local');
    expect(matchAccount(parseRemoteUrl('https://127.0.0.1:5000/g/p.git'), all)).toBeNull();
    expect(matchAccount(parseRemoteUrl('https://GITLAB.com/g/p'), all)?.id).toBe('gl');
  });

  it('ssh par sshHosts, port ignoré', () => {
    expect(matchAccount(parseRemoteUrl('git@gitlab.com:g/p.git'), all)?.id).toBe('gl');
    expect(matchAccount(parseRemoteUrl('ssh://git@altssh.gitlab.com:443/g/p.git'), all)?.id).toBe('gl');
    expect(matchAccount(parseRemoteUrl('ssh://git@git.exemple.org:2222/g/p.git'), all)?.id).toBe('self');
  });

  it('deux comptes sur un hôte : ok d’abord, puis le plus ancien', () => {
    const a = account({ id: 'recent', addedAt: 200 });
    const b = account({ id: 'ancien', addedAt: 50 });
    const c = account({ id: 'refuse', addedAt: 10, status: 'rejected' });
    expect(matchAccount(parseRemoteUrl('https://gitlab.com/g/p'), [a, c, b])?.id).toBe('ancien');
    expect(matchAccount(parseRemoteUrl('https://gitlab.com/g/p'), [c])?.id).toBe('refuse');
  });

  it('aucun compte', () => {
    expect(matchAccount(parseRemoteUrl('https://github.com/o/r'), all)).toBeNull();
    expect(matchAccount(parseRemoteUrl('git://gitlab.com/g/p'), all)).toBeNull();
    expect(matchAccount(null, all)).toBeNull();
    expect(matchAccount(parseRemoteUrl('https://gitlab.com/g/p'), [])).toBeNull();
  });
});

describe('accountForCredential', () => {
  const gl = account({ id: 'gl' });
  const local = account({ id: 'local', instanceUrl: 'http://127.0.0.1:5000', host: '127.0.0.1:5000', login: 'arbor-test' });

  it('https, identifiant vide ou égal au login', () => {
    expect(accountForCredential({ protocol: 'https', host: 'gitlab.com' }, [gl])?.id).toBe('gl');
    expect(accountForCredential({ protocol: 'https', host: 'gitlab.com', username: 'alice' }, [gl])?.id).toBe('gl');
    expect(accountForCredential({ protocol: 'https', host: 'gitlab.com', username: 'Alice' }, [gl])?.id).toBe('gl');
  });

  it('identifiant différent du login : pas de réponse', () => {
    expect(accountForCredential({ protocol: 'https', host: 'gitlab.com', username: 'bob' }, [gl])).toBeNull();
  });

  it('http seulement en boucle locale, port compris', () => {
    expect(accountForCredential({ protocol: 'http', host: '127.0.0.1:5000' }, [local])?.id).toBe('local');
    expect(accountForCredential({ protocol: 'http', host: '127.0.0.1:5001' }, [local])).toBeNull();
    expect(accountForCredential({ protocol: 'http', host: 'gitlab.com' }, [gl])).toBeNull();
  });

  it('ni ssh ni hôte absent', () => {
    expect(accountForCredential({ protocol: 'ssh', host: 'gitlab.com' }, [gl])).toBeNull();
    expect(accountForCredential({ protocol: 'https' }, [gl])).toBeNull();
  });
});
