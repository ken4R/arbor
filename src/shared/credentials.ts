// Identifiants Git (assistant d'identifiants et askpass d'Arbor) : fonctions pures, testées.
// - `needsAuth` : la commande Git peut-elle demander des identifiants (commande réseau) ?
// - protocole `git credential` : `parseCredentialFields`, `formatCredentialResponse`, `credentialOrigin` ;
// - invites d'askpass (Git et OpenSSH) : `classifyPrompt`, `parseHostKeyPrompt`, `parseKeyPathPrompt` ;
// - arguments `-c credential…` ajoutés devant une commande réseau : `credentialArgs` ;
// - assistants d'identifiants de l'utilisateur pour une URL : `effectiveHelpers`, `helperLabel`.

/**
 * Valeur (constante) de `credential.helper` pour l'assistant d'Arbor : Git l'exécute par le shell en ajoutant
 * l'action (`get`, `store`, `erase`). Aucune donnée dans cette chaîne : tout passe par `ARBOR_ASKPASS_*`.
 */
export const ARBOR_HELPER = '!"$ARBOR_GIT_HELPER" credential';

/** Options globales de Git suivies d'une valeur dans l'argument suivant. */
const GLOBAL_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix']);

/** Sous-commande et arguments après les options globales (`-c x`, `-C x`, `--no-optional-locks`…). */
function subcommand(args: readonly string[]): { cmd: string | null; rest: readonly string[] } {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (GLOBAL_WITH_VALUE.has(a)) i += 2;
    else if (a.startsWith('-')) i += 1;
    else return { cmd: a, rest: args.slice(i + 1) };
  }
  return { cmd: null, rest: [] };
}

/** Premier argument qui n'est pas une option. */
const firstWord = (rest: readonly string[]) => rest.find((a) => !a.startsWith('-')) ?? null;

/**
 * Vrai pour les commandes réseau, qui peuvent demander des identifiants : fetch, pull, push, clone, ls-remote,
 * `remote prune|update|show`, `submodule update|add` (clonage), `lfs fetch|pull|push|clone`. Les autres commandes ne
 * reçoivent ni `-c` ni variable : un `snapshot` reste identique au caractère près.
 */
export function needsAuth(args: readonly string[]): boolean {
  const { cmd, rest } = subcommand(args);
  switch (cmd) {
    case 'fetch':
    case 'pull':
    case 'push':
    case 'clone':
    case 'ls-remote':
      return true;
    case 'remote':
      return ['prune', 'update', 'show'].includes(firstWord(rest) ?? '');
    case 'submodule':
      return ['update', 'add'].includes(firstWord(rest) ?? '');
    case 'lfs':
      return ['fetch', 'pull', 'push', 'clone'].includes(firstWord(rest) ?? '');
    default:
      return false;
  }
}

/** Champs du protocole `git credential` qu'Arbor lit ; les autres (`capability[]`, `wwwauth[]`…) sont ignorés. */
const CREDENTIAL_KEYS = new Set(['protocol', 'host', 'path', 'username', 'password']);

export type CredentialFields = Partial<Record<'protocol' | 'host' | 'path' | 'username' | 'password', string>>;

/**
 * Analyse l'entrée d'un assistant `git credential` : lignes `clé=valeur`, arrêt à la première ligne vide. Les clés
 * inconnues (Git 2.46+ : `capability[]`, `authtype`, `credential`, `ephemeral`, `state[]`…) sont ignorées ; pour une
 * clé répétée, la dernière valeur gagne (comme Git).
 */
export function parseCredentialFields(stdin: string): CredentialFields {
  const out: CredentialFields = {};
  for (const raw of stdin.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') break;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i);
    if (CREDENTIAL_KEYS.has(key)) out[key as keyof CredentialFields] = line.slice(i + 1);
  }
  return out;
}

/** Réponse d'un assistant `git credential` ; lève une erreur si une clé ou une valeur contient `\n` ou `\0`. */
export function formatCredentialResponse(obj: Record<string, string | undefined>): string {
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (!/^[a-z_[\]]+$/.test(k)) throw new Error('Clé de réponse invalide.');
    if (/[\n\r\0]/.test(v)) throw new Error('Valeur interdite dans une réponse d’identifiants (saut de ligne ou NUL).');
    out += `${k}=${v}\n`;
  }
  return out;
}

/** Origine `protocole://hôte[:port]` d'une demande (minuscules), ou null s'il manque un champ. */
export function credentialOrigin(req: { protocol?: string | null; host?: string | null }): string | null {
  const protocol = (req.protocol ?? '').toLowerCase();
  const host = (req.host ?? '').toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(protocol) || !host) return null;
  return `${protocol}://${host}`;
}

/** Origine utilisable dans une clé `credential.<origine>.helper` (pas d'espace, de guillemet, de `=`…). */
const SAFE_ORIGIN = /^https?:\/\/[a-z0-9_.:[\]-]+$/;

/**
 * Arguments `-c` ajoutés devant une commande réseau. L'assistant d'Arbor s'ajoute en fin de liste pour tous les
 * hôtes (les assistants de l'utilisateur passent d'abord) ; pour l'origine d'un compte connecté, la liste est remise à
 * zéro (valeur vide) puis ne contient que l'assistant d'Arbor : le jeton n'est jamais recopié par le gestionnaire
 * d'identifiants de l'utilisateur. L'ordre compte : la ligne de commande est lue en dernier, et une valeur vide efface
 * tout ce qui précède (assistant générique compris), d'où l'assistant générique en premier.
 */
export function credentialArgs(accountOrigins: readonly string[]): string[] {
  const args = ['-c', `credential.helper=${ARBOR_HELPER}`];
  for (const origin of new Set(accountOrigins)) {
    if (!SAFE_ORIGIN.test(origin)) continue;
    args.push('-c', `credential.${origin}.helper=`, '-c', `credential.${origin}.helper=${ARBOR_HELPER}`);
  }
  return args;
}

/** Nom d'opération (handler IPC) → libellé affiché dans le titre du dialogue. */
const OPERATION_LABELS: Record<string, string> = {
  fetch: 'Fetch',
  fetchRemote: 'Fetch',
  pruneRemote: 'Nettoyage du remote',
  addRemote: 'Ajout du remote',
  pull: 'Pull',
  push: 'Push',
  pushBranch: 'Push',
  pushTag: 'Push du tag',
  pushAllTags: 'Push des tags',
  deleteRemoteTag: 'Suppression du tag distant',
  remoteTags: 'Tags distants',
  cloneRepo: 'Clonage',
  submoduleInit: 'Sous-module',
  submoduleReset: 'Sous-module',
  lfsFetch: 'LFS',
  lfsPull: 'LFS',
};

export function operationLabel(operation: string | null | undefined): string {
  return (operation && OPERATION_LABELS[operation]) || 'Opération Git';
}

// --- Invites d'askpass ---

export type PromptKind = 'https-username' | 'https-password' | 'ssh-passphrase' | 'ssh-password' | 'ssh-hostkey' | 'other';

export interface ClassifiedPrompt {
  kind: PromptKind;
  protocol: string | null;
  host: string | null;
  username: string | null;
  keyPath?: string;
  keyType?: string;
  fingerprint?: string;
}

/** `https://u@h:8443/x` → protocole, hôte (avec port) et identifiant ; null si ce n'est pas une URL. */
function splitPromptUrl(url: string): { protocol: string; host: string; username: string | null } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]*)@)?([^/]+)/i.exec(url);
  if (!m) return null;
  const user = m[2] ? m[2].split(':')[0] : null;
  let username: string | null = null;
  if (user) {
    try {
      username = decodeURIComponent(user);
    } catch {
      username = user;
    }
  }
  return { protocol: m[1].toLowerCase(), host: m[3].toLowerCase(), username };
}

/**
 * Invite de confirmation d'une clé d'hôte inconnue (OpenSSH 8.x et 9.x) :
 * « The authenticity of host 'h (1.2.3.4)' can't be established.\nED25519 key fingerprint is SHA256:….\n…
 * Are you sure you want to continue connecting (yes/no/[fingerprint])? ». null si ce n'en est pas une.
 */
export function parseHostKeyPrompt(prompt: string): { host: string; keyType: string; fingerprint: string } | null {
  if (!/Are you sure you want to continue connecting/.test(prompt)) return null;
  const h = /The authenticity of host '([^']+)' can't be established/.exec(prompt);
  const k = /^\s*([A-Z0-9-]+) key fingerprint is (\S+?)\.?\s*$/m.exec(prompt);
  if (!h || !k) return null;
  // « h (1.2.3.4) », « [h]:2222 ([1.2.3.4]:2222) » : on garde le nom tel qu'OpenSSH l'affiche, sans l'adresse.
  const host = h[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
  return { host, keyType: k[1], fingerprint: k[2] };
}

/** Chemin de la clé dans « Enter passphrase for key '/home/u/.ssh/id_ed25519': » ; null sinon. */
export function parseKeyPathPrompt(prompt: string): string | null {
  const m = /^Enter passphrase for (?:key )?(['"])(.+)\1(?: \([^)]*\))?:?$/.exec(prompt.trim());
  return m ? m[2] : null;
}

/** Classe une invite reçue par `GIT_ASKPASS` / `SSH_ASKPASS`. */
export function classifyPrompt(prompt: string): ClassifiedPrompt {
  const none = { protocol: null, host: null, username: null };
  const text = prompt.trim();
  let m = /^Username for '(.+)':?$/.exec(text);
  if (m) {
    const u = splitPromptUrl(m[1]);
    return { kind: 'https-username', ...(u ?? none) };
  }
  m = /^Password for '(.+)':?$/.exec(text);
  if (m) {
    const u = splitPromptUrl(m[1]);
    return { kind: 'https-password', ...(u ?? none) };
  }
  const hostKey = parseHostKeyPrompt(prompt);
  if (hostKey) return { kind: 'ssh-hostkey', protocol: 'ssh', host: hostKey.host, username: null, keyType: hostKey.keyType, fingerprint: hostKey.fingerprint };
  const keyPath = parseKeyPathPrompt(text);
  if (keyPath) return { kind: 'ssh-passphrase', protocol: 'ssh', host: null, username: null, keyPath };
  // « git@h's password: » (password) ; « (git@h) Password: » (keyboard-interactive, OpenSSH récent).
  m = /^(?:([^@\s']+)@)?([^\s']+)'s password:?$/.exec(text) ?? /^\((?:([^@\s)]+)@)?([^\s)]+)\) Password:?$/.exec(text);
  if (m) return { kind: 'ssh-password', protocol: 'ssh', host: m[2].toLowerCase(), username: m[1] ?? null };
  return { kind: 'other', ...none };
}

// --- Assistants d'identifiants de l'utilisateur ---

const DEFAULT_PORT: Record<string, string> = { https: '443', http: '80' };

interface UrlParts {
  protocol: string;
  user: string | null;
  host: string;
  port: string;
  path: string;
}

function urlParts(url: string): UrlParts | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]*)@)?(\[[^\]]+\]|[^/:]*)(?::(\d*))?(\/.*)?$/i.exec(url);
  if (!m) return null;
  const protocol = m[1].toLowerCase();
  return { protocol, user: m[2] ? m[2].split(':')[0] : null, host: m[3].toLowerCase(), port: m[4] || DEFAULT_PORT[protocol] || '', path: (m[5] ?? '/').replace(/\/+$/, '') };
}

/** `*.exemple.org` correspond à `git.exemple.org` (un joker par segment, comme Git). */
function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.split('.');
  const h = host.split('.');
  return p.length === h.length && p.every((s, i) => s === '*' || s === h[i]);
}

/** Correspondance d'une sous-section `credential.<motif>` avec une URL (règles de `git config --get-urlmatch`). */
function urlMatches(pattern: string, url: UrlParts): boolean {
  const p = urlParts(pattern);
  if (!p) return false;
  if (p.protocol !== url.protocol || !hostMatches(p.host, url.host) || p.port !== url.port) return false;
  if (p.user !== null && p.user !== url.user) return false;
  return p.path === '' || url.path === p.path || url.path.startsWith(p.path + '/');
}

/**
 * Assistants d'identifiants effectifs pour une URL, à partir des entrées de `git config -z --get-regexp
 * '^credential\..*helper$'` dans l'ordre de lecture : une valeur vide efface la liste, une sous-section doit
 * correspondre à l'URL. L'URL peut contenir un identifiant (`https://u@h/…`).
 */
export function effectiveHelpers(entries: readonly { key: string; value: string }[], url: string): string[] {
  const target = urlParts(url);
  if (!target) return [];
  let helpers: string[] = [];
  for (const { key, value } of entries) {
    const m = /^credential\.(?:(.+)\.)?helper$/i.exec(key);
    if (!m) continue;
    if (m[1] !== undefined && !urlMatches(m[1], target)) continue;
    if (value === '') helpers = [];
    else helpers.push(value);
  }
  return helpers;
}

/** Analyse la sortie de `git config -z --get-regexp` : enregistrements `clé\nvaleur\0` (valeur absente = vide). */
export function parseConfigEntries(out: string): { key: string; value: string }[] {
  return out
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      const i = rec.indexOf('\n');
      return i < 0 ? { key: rec, value: '' } : { key: rec.slice(0, i), value: rec.slice(i + 1) };
    });
}

/** Nom lisible d'un assistant : `store`, `osxkeychain`, `libsecret` ; « assistant personnalisé » pour `!…`. */
export function helperLabel(helper: string): string {
  const h = helper.trim();
  if (h.startsWith('!')) return 'assistant personnalisé';
  const first = /^"([^"]+)"|^(\S+)/.exec(h);
  const word = first ? (first[1] ?? first[2]) : h;
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/^git-credential-/, '').replace(/\.exe$/i, '');
}
