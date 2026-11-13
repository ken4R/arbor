// Adaptateur GitHub (github.com) : validation d'un jeton d'accès personnel par `GET /user`.
// `ARBOR_GITHUB_API_URL` remplace https://api.github.com (tests : `scripts/fake-forge.cjs`, sous `/github`).
import { gitUsername } from '../../shared/accounts';
import { ProviderError } from './http';
import { providers, type ApiClient, type ProviderAdapter, type ProviderIdentity } from './index';

/** Scopes d'un jeton classique (`X-OAuth-Scopes: repo, read:org`) ; null si l'en-tête est absent (permissions fines). */
export function parseGithubScopes(header: string | null): string[] | null {
  if (header === null) return null;
  return [...new Set(header.split(',').map((s) => s.trim()).filter(Boolean))];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export const github: ProviderAdapter = {
  kind: 'github',
  apiBase: () => (process.env.ARBOR_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  async validate(client: ApiClient): Promise<ProviderIdentity> {
    const { data, headers } = await client.request<Record<string, unknown> | null>('GET', '/user');
    const login = str(data?.login);
    if (!login) throw new ProviderError("Réponse inattendue de l'API GitHub (identité absente).", 'invalid');
    return { login, name: str(data?.name), avatarUrl: str(data?.avatar_url), scopes: parseGithubScopes(headers.get('x-oauth-scopes')) };
  },
  gitUsername: (account, kind) => gitUsername(account, kind),
  defaultSshHosts: () => ['github.com', 'ssh.github.com'],
};

providers.github = github;
