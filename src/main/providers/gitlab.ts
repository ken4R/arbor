// Adaptateur GitLab (gitlab.com ou instance auto-hébergée, éventuellement sous un préfixe `/gitlab`) : identité par
// `GET /user`, scopes par `GET /personal_access_tokens/self` (null si l'instance est trop ancienne).
// `ARBOR_GITLAB_COM_URL` remplace https://gitlab.com pour l'API (tests).
import { gitUsername } from '../../shared/accounts';
import { ProviderError } from './http';
import { providers, type ApiClient, type ProviderAdapter, type ProviderIdentity } from './index';

const GITLAB_COM = 'https://gitlab.com';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Hôte SSH d'un `hôte[:port]` HTTPS : port et crochets IPv6 retirés. */
export function sshHostOf(host: string): string {
  const h = host.toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h.slice(1);
  }
  return h.replace(/:\d+$/, '');
}

export const gitlab: ProviderAdapter = {
  kind: 'gitlab',
  apiBase(instanceUrl: string) {
    const inst = instanceUrl.replace(/\/+$/, '');
    const override = process.env.ARBOR_GITLAB_COM_URL;
    const base = inst === GITLAB_COM && override ? override.replace(/\/+$/, '') : inst;
    return `${base}/api/v4`;
  },
  async validate(client: ApiClient): Promise<ProviderIdentity> {
    const { data } = await client.request<Record<string, unknown> | null>('GET', '/user');
    const login = str(data?.username);
    if (!login) throw new ProviderError("Réponse inattendue : l'adresse ne semble pas être celle d'une instance GitLab.", 'invalid');
    let scopes: string[] | null = null;
    try {
      const self = await client.request<Record<string, unknown> | null>('GET', '/personal_access_tokens/self');
      const raw = self.data?.scopes;
      if (Array.isArray(raw)) scopes = raw.filter((s): s is string => typeof s === 'string');
    } catch {
      // Instance ancienne (route absente) : scopes inconnus.
      scopes = null;
    }
    return { login, name: str(data?.name), avatarUrl: str(data?.avatar_url), scopes };
  },
  gitUsername: (account, kind) => gitUsername(account, kind),
  defaultSshHosts(host: string) {
    const h = sshHostOf(host);
    return h === 'gitlab.com' ? ['gitlab.com', 'altssh.gitlab.com'] : [h];
  },
};

providers.gitlab = gitlab;
