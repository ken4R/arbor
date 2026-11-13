import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorMessage, createApiClient, isTokenPageUrl, networkErrorMessage, parseLinkHeader, PROVIDER_HEADERS, ProviderError, tokenError, type FetchImpl } from './http';
import { github, parseGithubScopes } from './github';
import { gitlab, sshHostOf } from './gitlab';
import { providers } from './index';

const TOKEN = 'glpat-secret-arbor-123';

/** fetch factice : enregistre les requêtes, répond avec la fonction donnée. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { impl, calls };
}

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function errorOf(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('aucune erreur levée');
}

describe('parseLinkHeader', () => {
  it('lit next, last et plusieurs rel', () => {
    const h = '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"';
    expect(parseLinkHeader(h)).toEqual({ next: 'https://api.github.com/user/repos?page=2', last: 'https://api.github.com/user/repos?page=5' });
  });
  it('accepte rel sans guillemets et des virgules dans l’URL', () => {
    expect(parseLinkHeader('<https://h/x?a=1,2>; rel=next')).toEqual({ next: 'https://h/x?a=1,2' });
  });
  it('vide ou mal formé', () => {
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader('')).toEqual({});
    expect(parseLinkHeader('n’importe quoi')).toEqual({});
  });
});

describe('apiErrorMessage', () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  it('401 : jeton refusé', () => {
    expect(apiErrorMessage(401, { message: 'Bad credentials' }, h())).toMatchObject({ kind: 'unauthorized', message: expect.stringContaining('Jeton refusé') });
  });
  it('403 avec limite d’appels : heure de reprise', () => {
    const reset = Math.floor(new Date(2026, 10, 12, 14, 5).getTime() / 1000);
    const r = apiErrorMessage(403, { message: 'API rate limit exceeded' }, h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    expect(r.kind).toBe('rate-limit');
    expect(r.message).toContain('14:05');
  });
  it('429 GitLab avec Retry-After', () => {
    const now = Math.floor(new Date(2026, 10, 12, 9, 0).getTime() / 1000);
    expect(apiErrorMessage(429, null, h({ 'retry-after': '120' }), now).message).toContain('09:02');
  });
  it('403 SSO', () => {
    expect(apiErrorMessage(403, { message: 'Resource protected by organization SAML enforcement.' }, h({ 'x-github-sso': 'required; url=https://github.com/orgs/o/sso' })).kind).toBe('sso');
    expect(apiErrorMessage(403, { message: 'Resource protected by organization SAML enforcement.' }, h()).kind).toBe('sso');
  });
  it('403 simple, 404, 500', () => {
    expect(apiErrorMessage(403, {}, h()).kind).toBe('forbidden');
    expect(apiErrorMessage(404, '<html>', h()).message).toContain('Instance introuvable');
    expect(apiErrorMessage(502, null, h()).message).toContain('502');
  });
  it('ne recopie jamais le corps de la réponse', () => {
    expect(apiErrorMessage(400, { message: `jeton ${TOKEN}` }, h()).message).not.toContain(TOKEN);
  });
});

describe('networkErrorMessage', () => {
  it('TLS (undici et Chromium)', () => {
    expect(networkErrorMessage(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })).kind).toBe('tls');
    expect(networkErrorMessage(new Error('net::ERR_CERT_AUTHORITY_INVALID')).kind).toBe('tls');
    expect(networkErrorMessage(Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } })).message).toContain('Certificat');
  });
  it('injoignable, délai', () => {
    expect(networkErrorMessage(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).message).toContain('Serveur injoignable');
    expect(networkErrorMessage(new Error('net::ERR_NAME_NOT_RESOLVED')).kind).toBe('network');
    expect(networkErrorMessage(new DOMException('The operation was aborted due to timeout', 'TimeoutError')).kind).toBe('timeout');
  });
});

describe('tokenError', () => {
  it('accepte un jeton ordinaire', () => {
    expect(tokenError('ghp_abcDEF123')).toBeNull();
    expect(tokenError('glpat-xx_yy.zz')).toBeNull();
  });
  it('refuse vide, espaces, contrôle, trop long, non-chaîne', () => {
    expect(tokenError('')).not.toBeNull();
    expect(tokenError('ab cd')).not.toBeNull();
    expect(tokenError('abc\n')).not.toBeNull();
    expect(tokenError('é')).not.toBeNull();
    expect(tokenError('a'.repeat(513))).not.toBeNull();
    expect(tokenError(42)).not.toBeNull();
  });
});

describe('isTokenPageUrl', () => {
  it('accepte les pages de création de jeton', () => {
    expect(isTokenPageUrl('https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=Arbor')).toBe(true);
    expect(isTokenPageUrl('https://gitlab.com/-/user_settings/personal_access_tokens?name=Arbor&scopes=api')).toBe(true);
    expect(isTokenPageUrl('https://git.exemple.org/gitlab/-/user_settings/personal_access_tokens?name=Arbor&scopes=api')).toBe(true);
  });
  it('refuse tout le reste', () => {
    expect(isTokenPageUrl('https://evil.example/')).toBe(false);
    expect(isTokenPageUrl('http://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=Arbor')).toBe(false);
    expect(isTokenPageUrl('http://127.0.0.1:5000/-/user_settings/personal_access_tokens?name=Arbor&scopes=api')).toBe(false);
    expect(isTokenPageUrl('https://u:p@gitlab.com/-/user_settings/personal_access_tokens?name=Arbor&scopes=api')).toBe(false);
    expect(isTokenPageUrl('file:///etc/passwd')).toBe(false);
    expect(isTokenPageUrl('javascript:alert(1)')).toBe(false);
    expect(isTokenPageUrl(null)).toBe(false);
  });
});

describe('scopes et hôtes', () => {
  it('parseGithubScopes', () => {
    expect(parseGithubScopes('repo, read:org')).toEqual(['repo', 'read:org']);
    expect(parseGithubScopes('')).toEqual([]);
    expect(parseGithubScopes(null)).toBeNull();
  });
  it('hôtes SSH par défaut', () => {
    expect(github.defaultSshHosts('github.com')).toEqual(['github.com', 'ssh.github.com']);
    expect(gitlab.defaultSshHosts('gitlab.com')).toEqual(['gitlab.com', 'altssh.gitlab.com']);
    expect(gitlab.defaultSshHosts('git.exemple.org:8443')).toEqual(['git.exemple.org']);
    expect(sshHostOf('[::1]:5000')).toBe('::1');
  });
  it('apiBase', () => {
    expect(gitlab.apiBase('https://git.exemple.org/gitlab')).toBe('https://git.exemple.org/gitlab/api/v4');
    const old = process.env.ARBOR_GITHUB_API_URL;
    delete process.env.ARBOR_GITHUB_API_URL;
    expect(github.apiBase('https://github.com')).toBe('https://api.github.com');
    process.env.ARBOR_GITHUB_API_URL = 'http://127.0.0.1:1/github/';
    expect(github.apiBase('https://github.com')).toBe('http://127.0.0.1:1/github');
    if (old === undefined) delete process.env.ARBOR_GITHUB_API_URL;
    else process.env.ARBOR_GITHUB_API_URL = old;
  });
  it('registre rempli', () => {
    expect(providers.github).toBe(github);
    expect(providers.gitlab).toBe(gitlab);
  });
});

describe('createApiClient (fetch factice)', () => {
  it('github.validate : en-têtes envoyés et scopes lus', async () => {
    const f = fakeFetch(() => jsonRes(200, { login: 'octo', name: 'Octo Cat', avatar_url: 'https://a/x.png' }, { 'X-OAuth-Scopes': 'repo, workflow' }));
    const client = createApiClient({ base: 'https://api.github.com', token: TOKEN, headers: PROVIDER_HEADERS.github, fetchImpl: f.impl });
    await expect(github.validate(client)).resolves.toEqual({ login: 'octo', name: 'Octo Cat', avatarUrl: 'https://a/x.png', scopes: ['repo', 'workflow'] });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe('https://api.github.com/user');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['User-Agent']).toBe('Arbor');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('github.validate : jeton à permissions fines, scopes inconnus', async () => {
    const f = fakeFetch(() => jsonRes(200, { login: 'octo', name: null }));
    const client = createApiClient({ base: 'https://api.github.com', token: TOKEN, fetchImpl: f.impl });
    expect((await github.validate(client)).scopes).toBeNull();
  });

  it('gitlab.validate : identité puis scopes ; scopes null si la route manque', async () => {
    const f = fakeFetch((url) => (url.endsWith('/user') ? jsonRes(200, { username: 'alice', name: 'Alice' }) : jsonRes(200, { scopes: ['read_api', 'write_repository'] })));
    const client = createApiClient({ base: 'https://git.exemple.org/gitlab/api/v4', token: TOKEN, fetchImpl: f.impl });
    expect(await gitlab.validate(client)).toEqual({ login: 'alice', name: 'Alice', avatarUrl: null, scopes: ['read_api', 'write_repository'] });
    expect(f.calls.map((c) => c.url)).toEqual(['https://git.exemple.org/gitlab/api/v4/user', 'https://git.exemple.org/gitlab/api/v4/personal_access_tokens/self']);

    const old = fakeFetch((url) => (url.endsWith('/user') ? jsonRes(200, { username: 'alice' }) : jsonRes(404, { message: '404 Not Found' })));
    expect((await gitlab.validate(createApiClient({ base: 'https://g/api/v4', token: TOKEN, fetchImpl: old.impl }))).scopes).toBeNull();
  });

  it('gitlab.validate : page HTML (pas une instance GitLab)', async () => {
    const f = fakeFetch(() => new Response('<html>Bienvenue</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const e = await errorOf(gitlab.validate(createApiClient({ base: 'https://exemple.org/api/v4', token: TOKEN, fetchImpl: f.impl })));
    expect(e.kind).toBe('invalid');
  });

  it('401 : erreur traduite sans jeton ni en-tête', async () => {
    const f = fakeFetch(() => jsonRes(401, { message: `401 Unauthorized ${TOKEN}` }, { 'WWW-Authenticate': 'Bearer' }));
    const e = await errorOf(github.validate(createApiClient({ base: 'https://api.github.com', token: TOKEN, fetchImpl: f.impl })));
    expect(e.kind).toBe('unauthorized');
    expect(e.status).toBe(401);
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toMatch(/Bearer|Authorization/);
  });

  it('erreur réseau : message sans jeton', async () => {
    const f = fakeFetch(() => {
      throw Object.assign(new TypeError(`fetch failed Bearer ${TOKEN}`), { cause: { code: 'ECONNREFUSED' } });
    });
    const e = await errorOf(github.validate(createApiClient({ base: 'https://api.github.com', token: TOKEN, fetchImpl: f.impl })));
    expect(e.kind).toBe('network');
    expect(e.message).not.toContain(TOKEN);
  });

  it('redirection refusée, jamais suivie', async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { Location: 'https://ailleurs.example/user' } }));
    const e = await errorOf(github.validate(createApiClient({ base: 'https://api.github.com', token: TOKEN, fetchImpl: f.impl })));
    expect(e.kind).toBe('redirect');
    expect(f.calls).toHaveLength(1);
  });

  it('chemin absolu ou lien de pagination vers une autre origine refusés', async () => {
    const f = fakeFetch(() => jsonRes(200, [], { Link: '<https://ailleurs.example/x?page=2>; rel="next"' }));
    const client = createApiClient({ base: 'https://api.github.com', token: TOKEN, fetchImpl: f.impl });
    expect((await client.request('GET', '/user/repos')).next).toBeNull();
    expect((await errorOf(client.request('GET', 'https://ailleurs.example/user'))).kind).toBe('redirect');
    expect(f.calls).toHaveLength(1);
    const same = fakeFetch(() => jsonRes(200, [], { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' }));
    expect((await createApiClient({ base: 'https://api.github.com', token: TOKEN, fetchImpl: same.impl }).request('GET', '/user/repos', { query: { per_page: '100' } })).next).toBe(
      'https://api.github.com/user/repos?page=2',
    );
    expect(same.calls[0].url).toBe('https://api.github.com/user/repos?per_page=100');
  });
});

describe('createApiClient contre fake-forge et un vrai serveur HTTP', () => {
  let forge: ChildProcess;
  let url = '';
  let redirector: Server;
  let redirectorUrl = '';
  let redirectedTo = 0;

  beforeAll(async () => {
    forge = spawn(process.execPath, [join(__dirname, '../../../scripts/fake-forge.cjs'), '--port', '0', '--token', TOKEN, '--scopes', 'read_api'], { stdio: ['ignore', 'pipe', 'inherit'] });
    url = await new Promise<string>((resolve, reject) => {
      let out = '';
      forge.stdout!.on('data', (d) => {
        out += d;
        const line = out.split('\n')[0];
        if (out.includes('\n')) resolve(JSON.parse(line).url);
      });
      forge.on('error', reject);
    });
    // Serveur qui redirige vers fake-forge : le client ne doit pas suivre.
    redirector = createServer((req, res) => {
      if (req.url?.startsWith('/cible')) {
        redirectedTo++;
        res.end('{}');
        return;
      }
      res.writeHead(301, { Location: `${url}/api/v4/user` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const addr = redirector.address();
    redirectorUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(() => {
    forge?.kill();
    redirector?.close();
  });

  it('GitLab : identité et scopes', async () => {
    const id = await gitlab.validate(createApiClient({ base: gitlab.apiBase(url), token: TOKEN, headers: PROVIDER_HEADERS.gitlab, fetchImpl: fetch }));
    expect(id).toEqual({ login: 'arbor-test', name: 'Arbor Test', avatarUrl: null, scopes: ['read_api'] });
  });

  it('GitHub (sous /github) : scopes de --scopes', async () => {
    const id = await github.validate(createApiClient({ base: `${url}/github`, token: TOKEN, headers: PROVIDER_HEADERS.github, fetchImpl: fetch }));
    expect(id.login).toBe('arbor-test');
    expect(id.scopes).toEqual(['read_api']);
  });

  it('mauvais jeton : 401 traduit', async () => {
    const e = await errorOf(gitlab.validate(createApiClient({ base: gitlab.apiBase(url), token: 'mauvais', fetchImpl: fetch })));
    expect(e.kind).toBe('unauthorized');
  });

  it('redirection HTTP réelle non suivie', async () => {
    const e = await errorOf(gitlab.validate(createApiClient({ base: `${redirectorUrl}/api/v4`, token: TOKEN, fetchImpl: fetch })));
    expect(e.kind).toBe('redirect');
    expect(redirectedTo).toBe(0);
  });

  it('serveur injoignable', async () => {
    const e = await errorOf(gitlab.validate(createApiClient({ base: 'http://127.0.0.1:1/api/v4', token: TOKEN, fetchImpl: fetch, timeoutMs: 3000 })));
    expect(['network', 'timeout']).toContain(e.kind);
  });
});
