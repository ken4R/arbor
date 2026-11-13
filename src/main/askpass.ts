// Assistant d'identifiants et askpass d'Arbor, côté processus principal.
//
// - Dossier d'exécution `mkdtemp(<base>/arbor-askpass-)` en 0700 (base : XDG_RUNTIME_DIR sous Linux s'il existe,
//   sinon le dossier temporaire) : `askpass.sh`, copie de `askpass-helper.js`, socket Unix `s` (tube nommé aléatoire
//   sous Windows). `askpass.sh` est essayé au démarrage : s'il ne s'exécute pas (dossier `noexec`), `startAskpass`
//   échoue et le crochet n'est pas installé (comportement d'avant l'assistant).
// - Sous Windows aussi, `SSH_ASKPASS` est `askpass.sh` : le ssh de Git for Windows le lance. L'OpenSSH de System32
//   n'est pas pris en charge pour les invites (pas de lanceur .cmd : l'invite, multiligne et en partie fournie par le
//   serveur, ne doit jamais passer par l'interpréteur cmd).
// - Serveur local : une ligne JSON par connexion (64 Kio au plus), jeton aléatoire comparé à temps constant,
//   session connue et en cours exigée.
// - Crochet de `git()` (`hook`) : pour une commande réseau (`needsAuth`), crée une session liée au contexte
//   d'opération, ajoute les `-c credential…` (`credentialArgs`) et les variables `GIT_ASKPASS`, `SSH_ASKPASS`,
//   `SSH_ASKPASS_REQUIRE=force`, `ARBOR_*`. La session est fermée à la sortie de la commande : demandes en attente
//   annulées, dialogue fermé (`credentialDone`).
// - Jamais touchés : SSH_AUTH_SOCK, GIT_SSH_COMMAND, known_hosts, StrictHostKeyChecking ; GIT_TERMINAL_PROMPT=0
//   reste imposé par `git()`.
// - Aucun secret dans les journaux : ce module ne journalise rien.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountOrigin, gitUsername } from '../shared/accounts';
import {
  classifyPrompt,
  credentialArgs,
  credentialOrigin,
  formatCredentialResponse,
  needsAuth,
  operationLabel,
  parseCredentialFields,
  type CredentialFields,
} from '../shared/credentials';
import type { AccountInfo, CredentialAnswer, CredentialKind, CredentialRequest } from '../shared/types';
import type { AccountSecret } from './accountStore';
import type { GitAuthHook } from './git';
import { currentOperation } from './opContext';

const MAX_REQUEST = 64 * 1024;
const MAX_VALUE = 4096;
const DEFAULT_TIMEOUT = 10 * 60 * 1000;
/** Délai d'inactivité d'une connexion avant sa requête complète (saut de ligne). */
const IDLE_TIMEOUT = 30 * 1000;
/** Longueur maximale d'un chemin de socket Unix (104 octets sous macOS, 108 sous Linux), avec une marge. */
const MAX_SOCKET_PATH = 100;

export interface AskpassStore {
  list(): AccountInfo[];
  findForCredential(req: { protocol?: string; host?: string; username?: string }): AccountInfo | null;
  secret(id: string): AccountSecret | null;
  markRejected(id: string): void;
}

export interface AskpassDeps {
  store: AskpassStore;
  send(event: 'credentialRequest' | 'credentialDone', payload: unknown): void;
  /** Assistants d'identifiants de l'utilisateur pour une URL (noms lisibles) ; [] en cas d'erreur. */
  userHelpers(repo: string | null, url: string): Promise<string[]>;
  /** `askpass-helper.js` construit (défaut : à côté de ce fichier). */
  helperSource?: string;
  /** Exécutable qui lance l'assistant (défaut : `process.execPath`, avec ELECTRON_RUN_AS_NODE=1). */
  nodePath?: string;
  /** Délai d'une demande interactive (défaut : 10 min). */
  timeoutMs?: number;
  /** Délai d'inactivité d'une connexion sans requête complète (défaut : 30 s). */
  idleTimeoutMs?: number;
  /** Dossiers candidats pour le dossier d'exécution (défaut : XDG_RUNTIME_DIR sous Linux, tmpdir, /tmp). */
  runtimeBases?: string[];
}

/** Demandes ouvertes par une connexion : annulées si l'assistant se termine avant la réponse (ssh l'a tué…). */
interface Connection {
  ids: Set<string>;
  closed: boolean;
}

export interface Askpass {
  hook: GitAuthHook;
  /**
   * Réponse du rendu à une demande (null : annulée). Une réponse invalide annule la demande (Git n'attend pas) puis
   * lève une erreur.
   */
  answer(id: string, a: CredentialAnswer | null): void;
  /** Oublie les identifiants mémorisés pour la session d'Arbor. */
  forgetSession(): void;
  stop(): void;
}

interface Pending {
  request: CredentialRequest;
  session: Session;
  resolve(a: CredentialAnswer | null): void;
  timer: NodeJS.Timeout;
}

interface Session {
  id: string;
  operation: string;
  repo: string | null;
  done: boolean;
  /** Une demande a été annulée : les suivantes de la même commande le sont aussi (pas de second dialogue). */
  cancelled: boolean;
  /** Origines des comptes dont l'assistant de l'utilisateur est écarté pour cette commande. */
  accountOrigins: Set<string>;
  /** Compte dont le jeton a été donné, par origine (pour `erase`). */
  given: Map<string, string>;
  /** Identifiants saisis avec « Mémoriser pendant cette session », retenus au `store` (connexion réussie). */
  toRemember: Map<string, { username: string; password: string }>;
  /** Mot de passe saisi avec l'identifiant dans le même dialogue (invites askpass Username puis Password). */
  askpassPasswords: Map<string, string>;
}

type Reply = { ok: true; out: string } | { ok: false; error: 'cancelled' | 'refused' };

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const secretValue = (s: AccountSecret) => (s.kind === 'pat' ? s.token : s.accessToken);

const validValue = (v: unknown, allowEmpty = true): v is string =>
  typeof v === 'string' && v.length <= MAX_VALUE && !/[\n\r\0]/.test(v) && (allowEmpty || v.length > 0);

/** Contenu de `askpass.sh` : aucune donnée, tout passe par l'environnement. */
const SH = '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$ARBOR_ASKPASS_NODE" "$ARBOR_ASKPASS_MAIN" "$@"\n';

const isDir = (p: string | undefined): p is string => {
  try {
    return !!p && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Base du dossier d'exécution : premier candidat existant dont le chemin de socket tient dans la limite. */
function runtimeBase(candidates: (string | undefined)[], win: boolean): string {
  const ok = candidates.filter(isDir);
  if (win) return ok[0] ?? tmpdir();
  return ok.find((b) => Buffer.byteLength(join(b, 'arbor-askpass-XXXXXX', 's')) <= MAX_SOCKET_PATH) ?? ok[0] ?? tmpdir();
}

/** Vérifie que `askpass.sh` s'exécute (dossier monté `noexec`, interpréteur absent…). */
function selfTest(sh: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    // Action inconnue : l'assistant sort aussitôt avec le code 0, sans contacter le serveur.
    execFile(sh, ['credential', 'selftest'], { env: { ...process.env, ...env }, timeout: 15000 }, (err) => (err ? reject(new Error('askpass')) : resolve()));
  });
}

export async function startAskpass(deps: AskpassDeps): Promise<Askpass> {
  const win = process.platform === 'win32';
  const base = runtimeBase(deps.runtimeBases ?? [process.platform === 'linux' ? process.env.XDG_RUNTIME_DIR : undefined, tmpdir(), win ? undefined : '/tmp'], win);
  const dir = mkdtempSync(join(base, 'arbor-askpass-'));
  let server: Server | null = null;
  try {
    return await setup(deps, dir, win, (s) => (server = s));
  } catch (e) {
    // Rien ne reste derrière un démarrage manqué (socket, scripts, copie de l'assistant).
    (server as Server | null)?.close();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

async function setup(deps: AskpassDeps, dir: string, win: boolean, onServer: (s: Server) => void): Promise<Askpass> {
  chmodSync(dir, 0o700);
  const sh = join(dir, 'askpass.sh');
  const helper = join(dir, 'askpass-helper.js');
  writeFileSync(sh, SH, { mode: 0o700 });
  // Copie hors de app.asar : le binaire en mode Node n'a pas à lire l'archive.
  copyFileSync(deps.helperSource ?? join(__dirname, 'askpass-helper.js'), helper);
  chmodSync(helper, 0o600);
  const nodePath = deps.nodePath ?? process.execPath;
  // Sous Windows, le sh de Git for Windows lance le script ; execFile ne le peut pas : pas d'essai.
  if (!win) await selfTest(sh, { ARBOR_ASKPASS_NODE: nodePath, ARBOR_ASKPASS_MAIN: helper });
  const socketPath = win ? `\\\\.\\pipe\\arbor-askpass-${randomBytes(16).toString('hex')}` : join(dir, 's');
  const token = randomBytes(32).toString('hex');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT;
  // Sous Windows, le sh de Git for Windows préfère les barres obliques.
  const shPath = win ? sh.replace(/\\/g, '/') : sh;

  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  /** Identifiants mémorisés pour la session d'Arbor, par origine. */
  const memory = new Map<string, { username: string; password: string }>();

  function finishRequest(id: string, a: CredentialAnswer | null) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    deps.send('credentialDone', { id });
    p.resolve(a);
  }

  /**
   * Demande au rendu ; null si annulée, expirée, si la commande s'est terminée ou si l'assistant qui attend la
   * réponse a disparu. Une annulation annule aussi les demandes suivantes de la commande (sauf `notify`).
   */
  function askUser(session: Session, conn: Connection, partial: Omit<CredentialRequest, 'id' | 'operation' | 'repo'>, notify = false): Promise<CredentialAnswer | null> {
    if (session.cancelled || session.done || conn.closed) return Promise.resolve(null);
    const request: CredentialRequest = { id: randomBytes(12).toString('hex'), operation: operationLabel(session.operation), repo: session.repo, ...partial };
    return new Promise((resolve) => {
      const timer = setTimeout(() => finishRequest(request.id, null), timeoutMs);
      pending.set(request.id, { request, session, resolve, timer });
      conn.ids.add(request.id);
      deps.send('credentialRequest', request);
    }).then((a) => {
      conn.ids.delete(request.id);
      if (a === null && !notify) session.cancelled = true;
      return a as CredentialAnswer | null;
    });
  }

  async function helpersFor(session: Session, origin: string, fields: CredentialFields): Promise<string[]> {
    // Hôte d'un compte : les assistants de l'utilisateur sont écartés pour cette commande.
    if (session.accountOrigins.has(origin)) return [];
    const user = fields.username ? `${encodeURIComponent(fields.username)}@` : '';
    const url = `${fields.protocol}://${user}${fields.host}/${fields.path ?? ''}`;
    try {
      return await deps.userHelpers(session.repo, url);
    } catch {
      return [];
    }
  }

  /** Origine d'un compte, ou null si elle est mal formée. */
  const originOf = (a: AccountInfo) => {
    try {
      return accountOrigin(a);
    } catch {
      return null;
    }
  };

  async function credentialGet(session: Session, conn: Connection, fields: CredentialFields): Promise<Reply> {
    const origin = credentialOrigin(fields);
    if (!origin) return { ok: true, out: '' };
    // 1. Compte connecté pour cet hôte, seulement si ses assistants ont été écartés au lancement de la commande
    //    (`-c credential.<origine>.helper=`) : sinon un assistant de l'utilisateur (store…) recopierait le jeton. Un
    //    compte connecté pendant la commande sert à la suivante.
    if (session.accountOrigins.has(origin)) {
      const account = deps.store.findForCredential({ protocol: fields.protocol, host: fields.host, username: fields.username });
      const secret = account && originOf(account) === origin ? deps.store.secret(account.id) : null;
      if (account && secret) {
        session.given.set(origin, account.id);
        return { ok: true, out: formatCredentialResponse({ username: gitUsername(account, secret.kind), password: secretValue(secret) }) };
      }
    }
    // Une demande de cette commande a été annulée : Git s'arrête, sans autre dialogue.
    if (session.cancelled) return { ok: true, out: 'quit=1\n' };
    // 2. Identifiants mémorisés pour la session.
    const mem = memory.get(origin);
    if (mem && (!fields.username || fields.username === mem.username)) return { ok: true, out: formatCredentialResponse(mem) };
    // 3. Demande interactive ; annulation : `quit=1`, Git s'arrête sans retomber sur GIT_ASKPASS.
    const a = await askUser(session, conn, {
      kind: 'https',
      protocol: fields.protocol ?? null,
      host: fields.host ?? null,
      username: fields.username || null,
      prompt: '',
      userHelpers: await helpersFor(session, origin, fields),
    });
    if (!a || a.kind !== 'https') return { ok: true, out: 'quit=1\n' };
    if (a.rememberForSession) session.toRemember.set(origin, { username: a.username, password: a.password });
    return { ok: true, out: formatCredentialResponse({ username: a.username, password: a.password }) };
  }

  function credentialStore(session: Session, fields: CredentialFields): Reply {
    // Connexion réussie : on retient ce que l'utilisateur a demandé de mémoriser. Le reste est ignoré : les hôtes
    // sans compte sont mémorisés par les assistants de l'utilisateur, c'est leur rôle.
    const origin = credentialOrigin(fields);
    const r = origin ? session.toRemember.get(origin) : undefined;
    if (origin && r && r.username === fields.username && fields.password !== undefined && sameSecret(r.password, fields.password)) memory.set(origin, r);
    return { ok: true, out: '' };
  }

  function credentialErase(session: Session, fields: CredentialFields): Reply {
    const origin = credentialOrigin(fields);
    if (!origin) return { ok: true, out: '' };
    memory.delete(origin);
    session.toRemember.delete(origin);
    // Jeton d'un compte refusé : le compte passe en « rejected » (jamais supprimé).
    const id = session.given.get(origin);
    const secret = id ? deps.store.secret(id) : null;
    if (id && secret && (fields.password === undefined || sameSecret(secretValue(secret), fields.password))) deps.store.markRejected(id);
    return { ok: true, out: '' };
  }

  async function askpassPrompt(session: Session, conn: Connection, prompt: string, promptMode: string | null): Promise<Reply> {
    const c = classifyPrompt(prompt);
    const ask = (partial: Omit<CredentialRequest, 'id' | 'operation' | 'repo'>, notify = false) => askUser(session, conn, partial, notify);
    const origin = credentialOrigin(c);
    const base = { protocol: c.protocol, host: c.host, username: c.username, prompt, userHelpers: [] as string[] };
    const cancelled: Reply = { ok: false, error: 'cancelled' };
    const secretOf = (a: CredentialAnswer | null): Reply => (a && a.kind === 'secret' ? { ok: true, out: a.value } : cancelled);
    // OpenSSH (SSH_ASKPASS_PROMPT) : `none` = simple notification (« touchez votre clé de sécurité »), fermée quand
    // ssh tue l'assistant ; `confirm` = oui/non. La question de clé d'hôte garde son dialogue dédié.
    if (c.kind !== 'ssh-hostkey' && promptMode === 'none') {
      await ask({ ...base, kind: 'ssh-notify' }, true);
      return { ok: true, out: '' };
    }
    if (c.kind !== 'ssh-hostkey' && promptMode === 'confirm') {
      const a = await ask({ ...base, kind: 'ssh-confirm' });
      return a && a.kind === 'confirm' && a.accept ? { ok: true, out: 'yes' } : cancelled;
    }
    switch (c.kind) {
      case 'https-username': {
        // Repli (l'assistant d'identifiants répond en principe avant) : un seul dialogue pour les deux invites.
        const a = await ask({ ...base, kind: 'https' });
        if (!a || a.kind !== 'https') return cancelled;
        if (origin) session.askpassPasswords.set(origin, a.password);
        return { ok: true, out: a.username };
      }
      case 'https-password': {
        const known = origin ? session.askpassPasswords.get(origin) : undefined;
        if (known !== undefined && origin) {
          session.askpassPasswords.delete(origin);
          return { ok: true, out: known };
        }
        return secretOf(await ask({ ...base, kind: 'other' }));
      }
      case 'ssh-hostkey': {
        const a = await ask({ ...base, kind: 'ssh-hostkey', keyType: c.keyType, fingerprint: c.fingerprint });
        if (!a || a.kind !== 'confirm') return cancelled;
        return { ok: true, out: a.accept ? 'yes' : 'no' };
      }
      case 'ssh-passphrase':
      case 'ssh-password':
      case 'other': {
        const kind: CredentialKind = c.kind;
        return secretOf(await ask({ ...base, kind, ...(c.keyPath ? { keyPath: c.keyPath } : {}) }));
      }
    }
  }

  async function handle(msg: unknown, conn: Connection): Promise<Reply> {
    if (!msg || typeof msg !== 'object') return { ok: false, error: 'refused' };
    const m = msg as Record<string, unknown>;
    if (typeof m.token !== 'string' || !sameSecret(m.token, token)) return { ok: false, error: 'refused' };
    const session = typeof m.session === 'string' ? sessions.get(m.session) : undefined;
    if (!session || session.done) return { ok: false, error: 'refused' };
    if (m.mode === 'credential' && typeof m.input === 'string') {
      const fields = parseCredentialFields(m.input);
      if (m.action === 'get') return credentialGet(session, conn, fields);
      if (m.action === 'store') return credentialStore(session, fields);
      if (m.action === 'erase') return credentialErase(session, fields);
      return { ok: true, out: '' };
    }
    if (m.mode === 'askpass' && typeof m.prompt === 'string') {
      const mode = m.promptMode === 'none' || m.promptMode === 'confirm' ? m.promptMode : null;
      return askpassPrompt(session, conn, m.prompt, mode);
    }
    return { ok: false, error: 'refused' };
  }

  function onConnection(socket: Socket) {
    let buf = '';
    let handled = false;
    const conn: Connection = { ids: new Set(), closed: false };
    socket.setEncoding('utf8');
    socket.setTimeout(deps.idleTimeoutMs ?? IDLE_TIMEOUT, () => socket.destroy());
    socket.on('error', () => {});
    // L'assistant a disparu avant la réponse (ssh l'a tué, Git interrompu) : demandes annulées, dialogue fermé.
    socket.on('close', () => {
      conn.closed = true;
      for (const id of [...conn.ids]) finishRequest(id, null);
    });
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST) {
        handled = true;
        socket.destroy();
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      handled = true; // une seule requête par connexion
      socket.setTimeout(0); // la réponse peut attendre l'utilisateur (délai propre aux demandes)
      let msg: unknown = null;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        // requête illisible : refusée
      }
      handle(msg, conn)
        .catch((): Reply => ({ ok: false, error: 'refused' }))
        .then((reply) => {
          if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n');
        });
    });
  }

  const server: Server = createServer(onConnection);
  onServer(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const hook: GitAuthHook = (args) => {
    if (!needsAuth(args)) return null;
    const ctx = currentOperation();
    const accountOrigins = new Set<string>();
    for (const a of deps.store.list()) {
      if (a.status !== 'ok') continue;
      try {
        accountOrigins.add(accountOrigin(a));
      } catch {
        // compte mal formé : ignoré
      }
    }
    const session: Session = {
      id: randomBytes(16).toString('hex'),
      operation: ctx?.operation ?? 'git',
      repo: ctx?.repo ?? null,
      done: false,
      cancelled: false,
      accountOrigins,
      given: new Map(),
      toRemember: new Map(),
      askpassPasswords: new Map(),
    };
    sessions.set(session.id, session);
    return {
      prefixArgs: credentialArgs([...accountOrigins]),
      env: {
        GIT_ASKPASS: sh,
        SSH_ASKPASS: sh,
        SSH_ASKPASS_REQUIRE: 'force',
        ARBOR_GIT_HELPER: shPath,
        ARBOR_ASKPASS_NODE: deps.nodePath ?? process.execPath,
        ARBOR_ASKPASS_MAIN: helper,
        ARBOR_ASKPASS_SOCKET: socketPath,
        ARBOR_ASKPASS_TOKEN: token,
        ARBOR_ASKPASS_SESSION: session.id,
      },
      done() {
        session.done = true;
        sessions.delete(session.id);
        for (const [id, p] of pending) if (p.session === session) finishRequest(id, null);
      },
    };
  };

  function answer(id: string, a: CredentialAnswer | null) {
    const p = pending.get(id);
    if (!p) return;
    if (a === null) return finishRequest(id, null);
    const kind = p.request.kind;
    // Réponse revérifiée : type attendu pour la demande, valeurs sans saut de ligne ni NUL.
    if (kind === 'https' && a.kind === 'https' && validValue(a.username, false) && validValue(a.password)) {
      return finishRequest(id, { kind: 'https', username: a.username, password: a.password, rememberForSession: a.rememberForSession === true });
    }
    if (kind === 'ssh-hostkey' && a.kind === 'confirm') return finishRequest(id, { kind: 'confirm', accept: a.accept === true });
    if (kind === 'ssh-confirm' && a.kind === 'confirm') return finishRequest(id, { kind: 'confirm', accept: a.accept === true });
    if (kind === 'ssh-notify') return finishRequest(id, null);
    if (kind !== 'https' && kind !== 'ssh-hostkey' && kind !== 'ssh-confirm' && a.kind === 'secret' && validValue(a.value)) return finishRequest(id, { kind: 'secret', value: a.value });
    // Réponse invalide (type inattendu, valeur trop longue ou multiligne) : la demande est annulée pour que Git ne
    // reste pas bloqué jusqu'au délai, puis l'erreur remonte au rendu.
    finishRequest(id, null);
    throw new Error('Réponse invalide pour cette demande d’identifiants : authentification annulée.');
  }

  return {
    hook,
    answer,
    forgetSession: () => memory.clear(),
    stop() {
      for (const id of [...pending.keys()]) finishRequest(id, null);
      for (const s of sessions.values()) s.done = true;
      sessions.clear();
      memory.clear();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
