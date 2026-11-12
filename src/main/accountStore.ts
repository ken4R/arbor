// Magasin des comptes connectés : `userData/accounts.json` (mode 0600), jetons chiffrés par `SecretCrypto`
// (`safeStorage`). Dépendances injectées : testable sans Electron.
//
// Règles :
// - le jeton ne sort jamais d'ici autrement que par `secret(id)`, appelé par le main (assistant d'identifiants,
//   client d'API) ; `list()` et `onChange` ne renvoient que des `AccountInfo`, sans secret ;
// - rien n'est jamais écrit en clair : si le chiffrement est faible (`basic_text`) ou indisponible, le compte est
//   gardé en mémoire seulement (`persisted: false`) ;
// - aucun journal ne contient de secret ni de contenu chiffré.
import { accountForCredential, missingScopes } from '../shared/accounts';
import { normalizeInstanceUrl } from '../shared/remoteUrl';
import type { AccountInfo, AccountStorageStatus } from '../shared/types';
import type { SecretCrypto } from './secrets';

/** Secret déchiffré ; union ouverte (device flow : jeton OAuth rafraîchissable). */
export type AccountSecret =
  | { kind: 'pat'; token: string }
  | { kind: 'oauth'; accessToken: string; refreshToken: string | null; expiresAt: number | null };

/** Entrée de `accounts.json` : `secret` = base64 de `crypto.encrypt(AccountSecret)`. Ne quitte jamais le main. */
export type StoredAccount = Omit<AccountInfo, 'missingScopes' | 'persisted'> & { secret: string };

/** Ce que l'appelant fournit à `add` (l'hôte est déduit de `instanceUrl`, la méthode du secret). */
export type AccountMeta = Pick<AccountInfo, 'provider' | 'instanceUrl' | 'sshHosts' | 'login' | 'name' | 'avatarUrl' | 'scopes'>;

export type AccountPatch = Partial<AccountMeta & Pick<AccountInfo, 'status' | 'validatedAt'>>;

export interface AccountStoreDeps {
  file: string;
  crypto: SecretCrypto;
  /** Lit le fichier ; lève une erreur de code `ENOENT` s'il n'existe pas. */
  readFile(file: string): string;
  /** Écrit le fichier atomiquement, en mode 0600. */
  writeFile(file: string, content: string): void;
  renameFile(from: string, to: string): void;
  /** Secondes depuis l'epoch. */
  now(): number;
  randomId(): string;
  /** Avertissement sans donnée sensible (fichier corrompu…). */
  warn?(message: string): void;
}

export interface AccountStore {
  list(): AccountInfo[];
  storage(): AccountStorageStatus;
  add(meta: AccountMeta, secret: AccountSecret): AccountInfo;
  /** Met à jour les métadonnées ; avec `secret`, remplace le jeton (le compte redevient « ok »). */
  update(id: string, patch: AccountPatch, secret?: AccountSecret): AccountInfo;
  remove(id: string): AccountInfo[];
  /** Secret déchiffré, ou null (compte inconnu ou secret illisible). */
  secret(id: string): AccountSecret | null;
  /** Compte (avec un secret lisible) qui répond à une demande `git credential get`. */
  findForCredential(req: { protocol?: string; host?: string; username?: string }): AccountInfo | null;
  /** Jeton refusé (Git ou API) : statut « rejected », jamais de suppression automatique. */
  markRejected(id: string): void;
  /** Abonnement aux changements ; renvoie le désabonnement. */
  onChange(cb: (accounts: AccountInfo[]) => void): () => void;
}

const PROVIDER_KINDS = new Set(['github', 'gitlab']);
const HOST_RE = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const strOrNull = (v: unknown): string | null => (isStr(v) && v ? v : null);

function isSecret(v: unknown): v is AccountSecret {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (s.kind === 'pat') return isStr(s.token) && s.token.length > 0;
  if (s.kind === 'oauth') return isStr(s.accessToken) && s.accessToken.length > 0;
  return false;
}

/**
 * Assainit le contenu de `accounts.json` (`{ version, accounts }`) : entrées invalides écartées, hôte recalculé
 * depuis l'URL d'instance, identifiants en double écartés (le premier est gardé).
 */
export function normalizeAccountsFile(raw: unknown): StoredAccount[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { accounts?: unknown }).accounts) ? (raw as { accounts: unknown[] }).accounts : [];
  const out: StoredAccount[] = [];
  const ids = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (!isStr(a.id) || !/^[\w-]{1,64}$/.test(a.id) || ids.has(a.id)) continue;
    if (!isStr(a.provider) || !PROVIDER_KINDS.has(a.provider)) continue;
    if (!isStr(a.instanceUrl)) continue;
    const inst = normalizeInstanceUrl(a.instanceUrl);
    if ('error' in inst) continue;
    if (!isStr(a.login) || !a.login.trim() || a.login.length > 255) continue;
    if (!isStr(a.secret) || !a.secret) continue;
    const sshHosts = Array.isArray(a.sshHosts) ? [...new Set(a.sshHosts.filter((h): h is string => isStr(h) && HOST_RE.test(h)))] : [];
    const scopes = Array.isArray(a.scopes) ? a.scopes.filter(isStr) : null;
    ids.add(a.id);
    out.push({
      id: a.id,
      provider: a.provider as StoredAccount['provider'],
      instanceUrl: inst.url,
      host: inst.host,
      sshHosts,
      login: a.login,
      name: strOrNull(a.name),
      avatarUrl: isStr(a.avatarUrl) && /^https?:\/\//.test(a.avatarUrl) ? a.avatarUrl : null,
      scopes,
      authMethod: a.authMethod === 'oauth' ? 'oauth' : 'pat',
      status: a.status === 'rejected' ? 'rejected' : 'ok',
      addedAt: isNum(a.addedAt) ? a.addedAt : 0,
      validatedAt: isNum(a.validatedAt) ? a.validatedAt : 0,
      secret: a.secret,
    });
  }
  return out;
}

interface Entry {
  rec: Omit<StoredAccount, 'secret'>;
  /** Secret chiffré (compte persisté) ; null = compte en mémoire seulement. */
  cipher: string | null;
  /** Secret des comptes en mémoire seulement. */
  memSecret: AccountSecret | null;
  /** false : secret chiffré illisible (trousseau réinitialisé, autre machine, chiffrement devenu indisponible). */
  readable: boolean;
}

export function createAccountStore(deps: AccountStoreDeps): AccountStore {
  let entries: Entry[] | null = null;
  let lastWritten: string | null = null;
  const listeners = new Set<(accounts: AccountInfo[]) => void>();

  const canPersist = () => deps.crypto.status().encryption === 'available';

  function tryDecrypt(cipher: string): AccountSecret | null {
    try {
      const s = deps.crypto.decrypt(cipher);
      return isSecret(s) ? s : null;
    } catch {
      return null;
    }
  }

  function load(): Entry[] {
    if (entries) return entries;
    let raw: string | null = null;
    try {
      raw = deps.readFile(deps.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') deps.warn?.('Comptes illisibles : aucun compte chargé.');
    }
    let parsed: unknown = undefined;
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw);
        lastWritten = raw;
      } catch {
        // Fichier corrompu : mis de côté au lieu d'être écrasé à la prochaine écriture.
        deps.warn?.('Fichier des comptes corrompu : mis de côté (.corrupt).');
        try {
          deps.renameFile(deps.file, `${deps.file}.corrupt`);
        } catch {
          // rien à mettre de côté
        }
      }
    }
    const available = canPersist();
    entries = normalizeAccountsFile(parsed).map(({ secret, ...rec }) => ({
      rec,
      cipher: secret,
      memSecret: null,
      readable: available && tryDecrypt(secret) !== null,
    }));
    return entries;
  }

  function info(e: Entry): AccountInfo {
    return {
      ...e.rec,
      sshHosts: [...e.rec.sshHosts],
      scopes: e.rec.scopes ? [...e.rec.scopes] : null,
      status: e.readable ? e.rec.status : 'rejected',
      missingScopes: missingScopes(e.rec.provider, e.rec.scopes),
      persisted: e.cipher !== null,
    };
  }

  const list = () => load().map(info);

  /** Remplace l'état et écrit les comptes persistés (seulement si le contenu change). Annule tout en cas d'échec. */
  function commit(next: Entry[]) {
    const persisted = next.filter((e) => e.cipher !== null).map((e) => ({ ...e.rec, secret: e.cipher }));
    const content = JSON.stringify({ version: 1, accounts: persisted }, null, 2);
    // Aucun fichier et rien à persister : on n'en crée pas.
    if (content !== lastWritten && !(lastWritten === null && persisted.length === 0)) {
      deps.writeFile(deps.file, content);
      lastWritten = content;
    }
    entries = next;
    const accounts = list();
    for (const cb of listeners) cb(accounts);
  }

  function find(id: string): Entry {
    const e = load().find((x) => x.rec.id === id);
    if (!e) throw new Error('Compte introuvable (il a peut-être été déconnecté entre-temps).');
    return e;
  }

  function withSecret(e: Entry, secret: AccountSecret): Entry {
    if (!isSecret(secret)) throw new Error('Secret invalide.');
    const rec = { ...e.rec, authMethod: secret.kind === 'oauth' ? ('oauth' as const) : ('pat' as const) };
    if (canPersist()) return { rec, cipher: deps.crypto.encrypt(secret), memSecret: null, readable: true };
    return { rec, cipher: null, memSecret: secret, readable: true };
  }

  function checkMeta(meta: AccountPatch): Partial<Entry['rec']> {
    const out: Partial<Entry['rec']> = {};
    if (meta.provider !== undefined) {
      if (!PROVIDER_KINDS.has(meta.provider)) throw new Error('Fournisseur inconnu.');
      out.provider = meta.provider;
    }
    if (meta.instanceUrl !== undefined) {
      const inst = normalizeInstanceUrl(meta.instanceUrl);
      if ('error' in inst) throw new Error(inst.error);
      out.instanceUrl = inst.url;
      out.host = inst.host;
    }
    if (meta.login !== undefined) {
      if (!meta.login.trim()) throw new Error('Identifiant du compte vide.');
      out.login = meta.login;
    }
    if (meta.sshHosts !== undefined) out.sshHosts = [...new Set(meta.sshHosts.map((h) => h.toLowerCase()).filter((h) => HOST_RE.test(h)))];
    if (meta.name !== undefined) out.name = meta.name || null;
    if (meta.avatarUrl !== undefined) out.avatarUrl = meta.avatarUrl && /^https?:\/\//.test(meta.avatarUrl) ? meta.avatarUrl : null;
    if (meta.scopes !== undefined) out.scopes = meta.scopes ? [...meta.scopes] : null;
    if (meta.status !== undefined) out.status = meta.status === 'rejected' ? 'rejected' : 'ok';
    if (meta.validatedAt !== undefined) out.validatedAt = meta.validatedAt;
    return out;
  }

  function secretOf(e: Entry): AccountSecret | null {
    if (e.memSecret) return e.memSecret;
    if (e.cipher === null || !e.readable) return null;
    return tryDecrypt(e.cipher);
  }

  return {
    list,
    storage: () => deps.crypto.status(),
    add(meta, secret) {
      const checked = checkMeta(meta);
      if (!checked.provider || !checked.instanceUrl || !checked.login) throw new Error('Compte incomplet.');
      const now = deps.now();
      const base: Entry = {
        rec: {
          id: deps.randomId(),
          provider: checked.provider,
          instanceUrl: checked.instanceUrl,
          host: checked.host!,
          sshHosts: checked.sshHosts ?? [],
          login: checked.login,
          name: checked.name ?? null,
          avatarUrl: checked.avatarUrl ?? null,
          scopes: checked.scopes ?? null,
          authMethod: 'pat',
          status: 'ok',
          addedAt: now,
          validatedAt: now,
        },
        cipher: null,
        memSecret: null,
        readable: true,
      };
      const entry = withSecret(base, secret);
      commit([...load(), entry]);
      return info(entry);
    },
    update(id, patch, secret) {
      const old = find(id);
      let entry: Entry = { ...old, rec: { ...old.rec, ...checkMeta(patch) } };
      if (secret) {
        entry = withSecret(entry, secret);
        if (patch.status === undefined) entry.rec.status = 'ok';
        if (patch.validatedAt === undefined) entry.rec.validatedAt = deps.now();
      }
      commit(load().map((e) => (e === old ? entry : e)));
      return info(entry);
    },
    remove(id) {
      const old = find(id);
      commit(load().filter((e) => e !== old));
      return list();
    },
    secret(id) {
      const e = load().find((x) => x.rec.id === id);
      return e ? secretOf(e) : null;
    },
    findForCredential(req) {
      // Même règle d'association que le rendu (shared/accounts.ts), parmi les comptes dont le secret est lisible.
      return accountForCredential(req, load().filter((e) => secretOf(e) !== null).map(info));
    },
    markRejected(id) {
      const e = load().find((x) => x.rec.id === id);
      if (!e || e.rec.status === 'rejected') return;
      commit(load().map((x) => (x === e ? { ...x, rec: { ...x.rec, status: 'rejected' } } : x)));
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
