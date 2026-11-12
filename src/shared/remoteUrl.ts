// Analyse des URL de remotes et des URL d'instance (GitHub, GitLab) : fonctions pures, utilisées par le main
// (assistant d'identifiants, comptes) et par le rendu (association remote → compte).

export interface RemoteLocation {
  protocol: 'https' | 'http' | 'ssh' | 'git';
  /** Minuscules, sans crochets IPv6, sans port. */
  host: string;
  /** null = port par défaut du protocole (443, 80, 22, 9418). */
  port: number | null;
  /** Jamais de mot de passe : `https://u:secret@h` donne `u`, le secret est jeté. */
  user: string | null;
  /** `groupe/sous-groupe/projet` : sans `/` initial ni final, sans `.git`, sans `~` SSH. */
  path: string;
  /** `groupe/sous-groupe` (tout sauf le dernier segment ; vide s'il n'y en a qu'un). */
  owner: string;
  /** `projet`. */
  name: string;
}

const DEFAULT_PORTS: Record<RemoteLocation['protocol'], number> = { https: 443, http: 80, ssh: 22, git: 9418 };

const SCHEMES: Record<string, RemoteLocation['protocol']> = {
  https: 'https',
  http: 'http',
  ssh: 'ssh',
  'git+ssh': 'ssh',
  'ssh+git': 'ssh',
  git: 'git',
};

/** Hôte valide : nom DNS (lettres, chiffres, `-`, `_`, `.`) ou adresse IPv6 (sans crochets). */
function validHost(host: string): boolean {
  return /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/.test(host) || (/^[0-9a-f:.]+$/.test(host) && host.includes(':'));
}

/** `hôte[:port]` tel que Git le donne à un assistant d'identifiants (IPv6 entre crochets, port omis s'il est nul). */
export function hostKey(host: string, port: number | null): string {
  const h = host.includes(':') ? `[${host}]` : host;
  return port === null ? h : `${h}:${port}`;
}

/** Hôte de boucle locale (http accepté pour les tests et les instances locales). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Sépare `hôte[:port]` (IPv6 entre crochets) ; null si invalide. */
function splitHostPort(hp: string): { host: string; port: number | null } | null {
  let host: string;
  let portText: string | null = null;
  if (hp.startsWith('[')) {
    const end = hp.indexOf(']');
    if (end < 0) return null;
    host = hp.slice(1, end);
    const rest = hp.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      portText = rest.slice(1);
    }
  } else {
    const i = hp.lastIndexOf(':');
    if (i >= 0) {
      host = hp.slice(0, i);
      portText = hp.slice(i + 1);
    } else host = hp;
  }
  host = host.toLowerCase();
  if (!host || !validHost(host)) return null;
  let port: number | null = null;
  if (portText !== null && portText !== '') {
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65535) return null;
  }
  return { host, port };
}

/** Nettoie un chemin de dépôt : `/`, `~` (SSH) et `.git` retirés ; null s'il ne reste rien. */
function cleanPath(raw: string, ssh: boolean): string | null {
  let p = raw.replace(/^\/+/, '');
  if (ssh) p = p.replace(/^~/, '');
  p = p.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const segments = p.split('/').filter(Boolean).map(decode);
  if (!segments.length || segments.some((s) => s === '.' || s === '..')) return null;
  return segments.join('/');
}

function location(protocol: RemoteLocation['protocol'], host: string, port: number | null, user: string | null, path: string): RemoteLocation {
  const i = path.lastIndexOf('/');
  return {
    protocol,
    host,
    port: port === DEFAULT_PORTS[protocol] ? null : port,
    user: user ? decode(user) : null,
    path,
    owner: i < 0 ? '' : path.slice(0, i),
    name: path.slice(i + 1),
  };
}

/**
 * Analyse une URL de remote (https, http, ssh, git, ou forme scp `utilisateur@hôte:chemin`). null pour une URL
 * locale (`file://`, chemin, lecteur Windows `C:\x` ou `C:/x`), vide, multiligne ou commençant par `-`.
 */
export function parseRemoteUrl(url: string): RemoteLocation | null {
  const u = url.trim();
  if (!u || u.startsWith('-') || /[\0\n\r\s]/.test(u)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(u);
  if (scheme) {
    const protocol = SCHEMES[scheme[1].toLowerCase()];
    if (!protocol) return null; // file://, ext:: et autres transports
    const rest = u.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const rawPath = slash < 0 ? '' : rest.slice(slash);
    const at = authority.lastIndexOf('@');
    const userinfo = at < 0 ? null : authority.slice(0, at);
    const hp = splitHostPort(at < 0 ? authority : authority.slice(at + 1));
    if (!hp) return null;
    // Le mot de passe éventuel (`u:secret@`) est jeté.
    const user = userinfo === null ? null : userinfo.split(':')[0] || null;
    const path = cleanPath(rawPath.replace(/[?#].*$/, ''), protocol === 'ssh');
    if (!path) return null;
    return location(protocol, hp.host, hp.port, user, path);
  }
  // Forme scp : `[utilisateur@]hôte:chemin`, sans `/` avant le premier `:` (sinon c'est un chemin local).
  let user: string | null = null;
  let rest = u;
  const at = rest.indexOf('@');
  if (at >= 0 && !rest.slice(0, at).includes('/') && !rest.slice(0, at).includes(':')) {
    user = rest.slice(0, at) || null;
    rest = rest.slice(at + 1);
  }
  let host: string;
  let path: string;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']:');
    if (end < 0) return null;
    host = rest.slice(1, end);
    path = rest.slice(end + 2);
  } else {
    const colon = rest.indexOf(':');
    if (colon < 0 || rest.slice(0, colon).includes('/')) return null;
    host = rest.slice(0, colon);
    path = rest.slice(colon + 1);
    // Une lettre seule avant `:` (sans utilisateur) est un lecteur Windows (`C:\x`, `C:/x`), pas un hôte.
    if (user === null && /^[a-z]$/i.test(host)) return null;
  }
  host = host.toLowerCase();
  if (!host || !validHost(host)) return null;
  // `git@h:2222/o/r` : en forme scp, `2222` est un segment du chemin, pas un port.
  const clean = cleanPath(path, true);
  if (!clean) return null;
  return location('ssh', host, null, user, clean);
}

/**
 * Normalise l'URL d'une instance (GitLab auto-hébergé…) : https exigé (http seulement vers la boucle locale),
 * ni identifiants, ni requête, ni fragment ; préfixe de chemin gardé (`/gitlab`), `/` final retiré. Sans schéma,
 * `https://` est ajouté. `host` = `hôte[:port]` en minuscules, port omis s'il vaut le défaut.
 */
export function normalizeInstanceUrl(input: string): { url: string; host: string } | { error: string } {
  let raw = input.trim();
  if (!raw) return { error: "L'URL de l'instance est vide." };
  if (/[\s"'`\\<>^{}|]/.test(raw) || /[\0-\x1f\x7f]/.test(raw)) return { error: "L'URL de l'instance contient des caractères interdits." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:/]+:\d/.test(raw)) return { error: "L'URL de l'instance doit commencer par https://." };
    raw = `https://${raw}`;
  }
  if (/\/\.\.?(?:\/|$)/.test(raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))) return { error: "L'URL de l'instance n'est pas valide." };
  if (/[?#]/.test(raw)) return { error: "L'URL de l'instance ne doit contenir ni requête (?) ni fragment (#)." };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: "L'URL de l'instance n'est pas valide." };
  }
  if (parsed.username || parsed.password || /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(raw)) {
    return { error: "L'URL de l'instance ne doit pas contenir d'identifiants : le jeton se saisit à part." };
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    return { error: "L'URL de l'instance doit commencer par https:// (http:// n'est accepté que vers la machine locale)." };
  }
  if (parsed.port === '0') return { error: "Le port de l'instance n'est pas valide." };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || !validHost(hostname)) return { error: "L'hôte de l'instance n'est pas valide." };
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path.split('/').some((s) => s === '.' || s === '..')) return { error: "L'URL de l'instance n'est pas valide." };
  const host = parsed.host.toLowerCase();
  return { url: `${parsed.protocol}//${host}${path}`, host };
}

/**
 * Masque les identifiants des URL d'un texte quelconque : tout ce qui précède le dernier `@` de l'autorité.
 * `https://u:xxx@h` → `https://u:•••@h` ; `https://jeton@h` (jeton seul en identifiant) → `https://•••@h`.
 */
export function redactUrlCredentials(text: string): string {
  // Autorité : jusqu'au premier `/` (ou espace, guillemet) ; le `*` gourmand s'arrête au dernier `@`.
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/'"<>]*)@/gi, (_m, scheme: string, userinfo: string) => {
    const colon = userinfo.indexOf(':');
    return colon < 0 ? `${scheme}•••@` : `${scheme}${userinfo.slice(0, colon)}:•••@`;
  });
}

/**
 * Chemin du projet chez l'hébergeur (`groupe/sous/projet`), préfixe d'instance retiré pour une URL http(s)
 * (GitLab servi sous `/gitlab`) ; null si l'URL http(s) n'est pas sous ce préfixe. Les URL SSH n'ont pas de préfixe.
 */
export function projectPathFor(instanceUrl: string, loc: RemoteLocation): string | null {
  if (loc.protocol !== 'https' && loc.protocol !== 'http') return loc.path || null;
  const norm = normalizeInstanceUrl(instanceUrl);
  if ('error' in norm) return null;
  const prefix = new URL(norm.url).pathname.replace(/^\/+|\/+$/g, '');
  if (!prefix) return loc.path || null;
  // Les chemins d'URL sont sensibles à la casse, mais GitLab sert son préfixe quelle que soit la casse saisie.
  if (!loc.path.toLowerCase().startsWith(prefix.toLowerCase() + '/')) return null;
  return loc.path.slice(prefix.length + 1) || null;
}
