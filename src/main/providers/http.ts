// Client HTTP des API d'hébergeurs (GitHub, GitLab), dans le processus principal uniquement.
//
// Règles :
// - le jeton n'est envoyé qu'à l'origine de `base` : aucune redirection suivie (`redirect: 'manual'`, une réponse
//   3xx est une erreur), lien de pagination ignoré s'il vise une autre origine ;
// - aucun message d'erreur ne contient d'en-tête, de jeton ni le corps brut de la réponse (textes fixes) ;
// - rien n'est journalisé ;
// - `fetchImpl` est injectable (tests : `fetch` de Node) ; par défaut `net.fetch` d'Electron (pile réseau de
//   Chromium : proxy système, PAC et autorités de certification du système).
import type { ProviderKind } from '../../shared/types';
import { PROVIDERS } from '../../shared/accounts';
import { normalizeInstanceUrl } from '../../shared/remoteUrl';
import type { ApiClient } from './index';

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export type ProviderErrorKind = 'unauthorized' | 'forbidden' | 'rate-limit' | 'sso' | 'not-found' | 'redirect' | 'network' | 'tls' | 'timeout' | 'invalid' | 'http';

/** Erreur d'API traduite (message en français, sans en-tête ni jeton). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** En-têtes propres à chaque fournisseur (en plus d'`Authorization` et `User-Agent`). */
export const PROVIDER_HEADERS: Record<ProviderKind, Record<string, string>> = {
  github: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  gitlab: { Accept: 'application/json' },
};

/** Jeton saisi acceptable : non vide, sans espace ni caractère de contrôle, ASCII imprimable, 512 caractères au plus. */
export function tokenError(token: unknown): string | null {
  if (typeof token !== 'string' || !token) return 'Saisissez un jeton d’accès personnel.';
  if (token.length > 512) return 'Jeton trop long (512 caractères au plus).';
  if (/\s/.test(token)) return 'Le jeton ne doit pas contenir d’espace : vérifiez le copier-coller.';
  if (!/^[\x21-\x7e]+$/.test(token)) return 'Le jeton contient des caractères inattendus : vérifiez le copier-coller.';
  return null;
}

/**
 * Analyse un en-tête `Link` (RFC 8288) : `{ next: url, last: url… }`. Les entrées mal formées sont ignorées.
 */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]*)>\s*((?:;[^;]*)*)$/.exec(part);
    if (!m) continue;
    for (const param of m[2].split(';')) {
      const p = /^\s*rel\s*=\s*"?([^"]*)"?\s*$/i.exec(param);
      if (!p) continue;
      for (const rel of p[1].trim().split(/\s+/)) if (rel && !(rel in out)) out[rel.toLowerCase()] = m[1];
    }
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Heure locale HH:MM d'un instant en secondes epoch. */
function clock(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Instant de fin de la limite d'appels (secondes epoch), d'après les en-têtes GitHub ou GitLab ; null si inconnu. */
function rateLimitReset(headers: Headers, nowSeconds: number): number | null {
  const reset = Number(headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset') ?? NaN);
  if (Number.isFinite(reset) && reset > 0) return reset;
  const retry = Number(headers.get('retry-after') ?? NaN);
  if (Number.isFinite(retry) && retry >= 0) return nowSeconds + retry;
  return null;
}

/**
 * Message d'une réponse d'erreur de l'API (pure) : textes fixes, jamais le corps ni les en-têtes. `body` ne sert
 * qu'à reconnaître des cas (limite d'appels, SSO) ; `nowSeconds` pour `Retry-After`.
 */
export function apiErrorMessage(status: number, body: unknown, headers: Headers, nowSeconds = Math.floor(Date.now() / 1000)): { message: string; kind: ProviderErrorKind } {
  const text = typeof body === 'string' ? body : body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : '';
  if (status === 401) return { kind: 'unauthorized', message: 'Jeton refusé (expiré ou révoqué) : créez un nouveau jeton et reconnectez le compte.' };
  const rateLimited = status === 429 || (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.get('ratelimit-remaining') === '0' || /rate limit/i.test(text)));
  if (rateLimited) {
    const reset = rateLimitReset(headers, nowSeconds);
    return { kind: 'rate-limit', message: reset !== null ? `Limite d'appels à l'API atteinte, réessayez à ${clock(reset)}.` : "Limite d'appels à l'API atteinte, réessayez plus tard." };
  }
  if (status === 403 && (headers.get('x-github-sso') !== null || /\bSAML\b|\bSSO\b/.test(text))) {
    return { kind: 'sso', message: "Autorisez le jeton pour l'organisation (SSO) dans les paramètres du jeton, puis réessayez." };
  }
  if (status === 403) return { kind: 'forbidden', message: 'Accès refusé par l’API (403) : le jeton n’a pas les droits nécessaires.' };
  if (status === 404) return { kind: 'not-found', message: "Instance introuvable : vérifiez l'URL (API absente à cette adresse)." };
  if (status >= 500) return { kind: 'http', message: `Le serveur a rencontré une erreur (${status}) : réessayez plus tard.` };
  return { kind: 'http', message: `Réponse inattendue de l'API (${status}).` };
}

/** Codes et motifs d'erreurs TLS (Node/undici et Chromium `net::ERR_CERT_*`). */
const TLS_RE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_CERT|ERR_SSL/i;

/** Message d'une erreur réseau levée par `fetch` (pure) : texte fixe, jamais l'URL avec ses paramètres. */
export function networkErrorMessage(err: unknown): { message: string; kind: ProviderErrorKind } {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown; name?: unknown } } | null;
  const parts = [e?.name, e?.code, e?.message, e?.cause?.name, e?.cause?.code, e?.cause?.message].filter((x): x is string => typeof x === 'string');
  const all = parts.join(' ');
  if (/TimeoutError|ERR_TIMED_OUT|ETIMEDOUT|aborted due to timeout/i.test(all)) return { kind: 'timeout', message: "Le serveur n'a pas répondu à temps : vérifiez la connexion et réessayez." };
  if (/redirect/i.test(all)) return { kind: 'redirect', message: "L'API a répondu par une redirection : vérifiez l'URL de l'instance (le jeton n'a pas été envoyé ailleurs)." };
  if (TLS_RE.test(all)) return { kind: 'tls', message: "Certificat du serveur non reconnu : l'autorité de certification n'est pas approuvée par le système." };
  return { kind: 'network', message: "Serveur injoignable : vérifiez l'URL de l'instance et la connexion." };
}

export interface ApiClientOptions {
  /** Base de l'API (`https://api.github.com`, `<instance>/api/v4`), sans `/` final. */
  base: string;
  token: string;
  /** En-têtes du fournisseur (`PROVIDER_HEADERS`). */
  headers?: Record<string, string>;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/** `net.fetch` d'Electron, chargé à la demande (les tests injectent `fetchImpl` et ne chargent pas Electron). */
function electronFetch(): FetchImpl {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { net } = require('electron') as typeof import('electron');
  return (url, init) => net.fetch(url, init);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Client authentifié pour une API ; le jeton reste dans cette fermeture (jamais exposé ni journalisé). */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  const base = opts.base.replace(/\/+$/, '');
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    throw new ProviderError("Adresse de l'API invalide.", 'invalid');
  }
  const token = opts.token;
  const timeoutMs = opts.timeoutMs ?? 15000;
  let fetchImpl = opts.fetchImpl ?? null;

  return {
    async request<T>(method: string, path: string, ro?: { query?: Record<string, string>; body?: unknown }) {
      // Chemin relatif à la base, ou URL absolue de pagination (même origine seulement).
      let url: URL;
      if (/^https?:\/\//i.test(path)) url = new URL(path);
      else {
        if (!path.startsWith('/')) throw new ProviderError("Chemin d'API invalide.", 'invalid');
        url = new URL(base + path);
      }
      if (url.origin !== origin) throw new ProviderError("Adresse hors de l'instance refusée.", 'redirect');
      for (const [k, v] of Object.entries(ro?.query ?? {})) url.searchParams.set(k, v);
      const headers: Record<string, string> = { 'User-Agent': 'Arbor', ...(opts.headers ?? {}), Authorization: `Bearer ${token}` };
      let body: string | undefined;
      if (ro?.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(ro.body);
      }
      let res: Response;
      try {
        fetchImpl ??= electronFetch();
        res = await fetchImpl(url.toString(), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const m = networkErrorMessage(err);
        throw new ProviderError(m.message, m.kind);
      }
      // Redirection non suivie : `opaqueredirect` (navigateur), ou 3xx avec Location (Node, Electron).
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || res.redirected) {
        void res.body?.cancel().catch(() => {});
        throw new ProviderError(networkErrorMessage({ message: 'redirect' }).message, 'redirect', res.status || null);
      }
      let data: unknown;
      try {
        data = await readBody(res);
      } catch (err) {
        const m = networkErrorMessage(err);
        throw new ProviderError(m.message, m.kind);
      }
      if (!res.ok) {
        const m = apiErrorMessage(res.status, data, res.headers);
        throw new ProviderError(m.message, m.kind, res.status);
      }
      if (data !== null && typeof data !== 'object') {
        throw new ProviderError("Réponse inattendue : l'adresse ne semble pas être celle d'une API GitHub ou GitLab.", 'invalid', res.status);
      }
      const nextRaw = parseLinkHeader(res.headers.get('link')).next ?? null;
      let next: string | null = null;
      if (nextRaw) {
        try {
          const n = new URL(nextRaw, url);
          if (n.origin === origin) next = n.toString();
        } catch {
          next = null;
        }
      }
      return { data: data as T, headers: res.headers, next };
    },
  };
}

/**
 * URL de page « créer un jeton » qu'`openExternal` accepte d'ouvrir : exactement `PROVIDERS[p].tokenUrl(instance)`
 * pour une instance https normalisée (pure). Toute autre URL est refusée.
 */
export function isTokenPageUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 2048 || !/^https:\/\//.test(url)) return false;
  for (const p of Object.values(PROVIDERS)) {
    const suffix = p.tokenUrl('');
    if (!url.endsWith(suffix)) continue;
    const inst = normalizeInstanceUrl(url.slice(0, url.length - suffix.length));
    if ('error' in inst || !inst.url.startsWith('https://')) continue;
    if (p.tokenUrl(inst.url) === url) return true;
  }
  return false;
}
