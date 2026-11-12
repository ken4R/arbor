// Comptes GitHub/GitLab : description des fournisseurs et association remote → compte. Fonctions pures.
import type { AccountInfo, ProviderKind } from './types';
import { hostKey, isLoopbackHost, type RemoteLocation } from './remoteUrl';

export interface ProviderDescription {
  label: string;
  /** Instance par défaut (github.com, gitlab.com). */
  defaultInstance: string;
  /** Page de création d'un jeton d'accès personnel, scopes pré-cochés. */
  tokenUrl: (instance: string) => string;
  /** Alternatives de scopes suffisantes : une seule doit être entièrement présente. */
  requiredScopes: string[][];
  /** Scopes conseillés en plus (non exigés). */
  recommendedScopes: string[];
  /** Aide affichée sous le champ jeton. */
  scopeHelp: string;
}

export const PROVIDERS: Record<ProviderKind, ProviderDescription> = {
  github: {
    label: 'GitHub',
    defaultInstance: 'https://github.com',
    tokenUrl: (instance) => `${instance}/settings/tokens/new?scopes=repo,read:org,workflow&description=Arbor`,
    requiredScopes: [['repo']],
    recommendedScopes: ['read:org', 'workflow'],
    scopeHelp:
      "Jeton classique : scope « repo » (plus « read:org », et « workflow » pour pousser des fichiers .github/workflows). Jeton à permissions fines : accès « Contents » et « Pull requests » en lecture et écriture.",
  },
  gitlab: {
    label: 'GitLab',
    defaultInstance: 'https://gitlab.com',
    tokenUrl: (instance) => `${instance}/-/user_settings/personal_access_tokens?name=Arbor&scopes=api`,
    requiredScopes: [['api'], ['read_api', 'write_repository']],
    recommendedScopes: [],
    scopeHelp: "Scope « api » (ou « read_api » et « write_repository », sans les merge requests).",
  },
};

/**
 * Scopes requis manquants : [] si une alternative est entièrement présente ou si les scopes sont inconnus (null :
 * jeton GitHub à permissions fines) ; sinon l'alternative à laquelle il manque le moins de scopes (à égalité, celle
 * dont le jeton a déjà le plus de scopes : `read_api` seul donne `write_repository`, pas `api`).
 */
export function missingScopes(provider: ProviderKind, scopes: string[] | null): string[] {
  if (scopes === null) return [];
  const have = new Set(scopes);
  let best: { missing: string[]; present: number } | null = null;
  for (const alt of PROVIDERS[provider].requiredScopes) {
    const missing = alt.filter((s) => !have.has(s));
    if (!missing.length) return [];
    const present = alt.length - missing.length;
    if (best === null || missing.length < best.missing.length || (missing.length === best.missing.length && present > best.present)) best = { missing, present };
  }
  return best?.missing ?? [];
}

/** Ordre de préférence entre comptes d'un même hôte : statut « ok » d'abord, puis le plus ancien. */
function byPreference(a: AccountInfo, b: AccountInfo): number {
  if (a.status !== b.status) return a.status === 'ok' ? -1 : 1;
  return a.addedAt - b.addedAt;
}

function instanceScheme(account: Pick<AccountInfo, 'instanceUrl'>): string {
  return account.instanceUrl.slice(0, account.instanceUrl.indexOf(':'));
}

/**
 * Compte associé à un remote : https/http par `hôte[:port]` (et même schéma que l'instance) ; ssh par
 * `sshHosts` (port ignoré). Plusieurs comptes : statut « ok » d'abord, puis le plus ancien. Le protocole git:// n'a
 * pas d'authentification.
 */
export function matchAccount(loc: RemoteLocation | null, accounts: readonly AccountInfo[]): AccountInfo | null {
  if (!loc) return null;
  let found: AccountInfo[];
  if (loc.protocol === 'https' || loc.protocol === 'http') {
    const key = hostKey(loc.host, loc.port);
    found = accounts.filter((a) => a.host === key && instanceScheme(a) === loc.protocol);
  } else if (loc.protocol === 'ssh') {
    found = accounts.filter((a) => a.sshHosts.includes(loc.host));
  } else return null;
  return found.sort(byPreference)[0] ?? null;
}

/** Identifiants génériques qu'on trouve dans les URL de remotes à jeton (`https://oauth2@gitlab.com/…`). */
const GENERIC_GIT_USERNAMES = new Set(['oauth2', 'git', 'x-access-token']);

/**
 * Compte qui peut répondre à une demande `git credential get` : https (ou http en boucle locale) seulement, hôte
 * identique (`host` de Git inclut le port), identifiant vide, égal au login du compte, ou générique (`oauth2`,
 * `git`, `x-access-token`).
 */
export function accountForCredential(req: { protocol?: string; host?: string; username?: string }, accounts: readonly AccountInfo[]): AccountInfo | null {
  const protocol = (req.protocol ?? '').toLowerCase();
  const host = (req.host ?? '').toLowerCase();
  if (!host) return null;
  if (protocol !== 'https' && !(protocol === 'http' && isLoopbackHost(host.replace(/:\d+$/, '')))) return null;
  const username = req.username ?? '';
  const found = accounts.filter(
    (a) => a.host === host && instanceScheme(a) === protocol && (username === '' || username.toLowerCase() === a.login.toLowerCase() || GENERIC_GIT_USERNAMES.has(username.toLowerCase())),
  );
  return found.sort(byPreference)[0] ?? null;
}

/**
 * Identifiant à présenter à Git avec le jeton : le login ; `oauth2` pour un jeton OAuth GitLab (GitLab ignore
 * l'identifiant pour un jeton personnel, mais l'exige égal à `oauth2` pour un jeton OAuth).
 */
export function gitUsername(account: Pick<AccountInfo, 'provider' | 'login'>, secretKind: 'pat' | 'oauth'): string {
  if (account.provider === 'gitlab' && secretKind === 'oauth') return 'oauth2';
  return account.login;
}

const ORIGIN_RE = /^https?:\/\/[a-z0-9_.:\[\]-]+$/;

/**
 * Origine Git du compte (`https://hôte[:port]`, ou `http://` en boucle locale), utilisable telle quelle dans une clé
 * de configuration `credential.<origine>.helper` : ni espace, ni guillemet, ni `=`, ni saut de ligne. Lève une
 * erreur si le compte est mal formé (jamais le cas après `normalizeInstanceUrl`).
 */
export function accountOrigin(account: Pick<AccountInfo, 'instanceUrl' | 'host'>): string {
  const origin = `${instanceScheme(account)}://${account.host}`;
  if (!ORIGIN_RE.test(origin)) throw new Error('Origine de compte invalide.');
  return origin;
}
