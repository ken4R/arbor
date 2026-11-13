// Assistant d'identifiants et askpass d'Arbor, côté processus principal.
//
// - Dossier d'exécution `mkdtemp(tmpdir/arbor-askpass-)` en 0700 : `askpass.sh` (et `askpass.cmd` sous Windows),
//   copie de `askpass-helper.js`, socket Unix `s` (tube nommé aléatoire sous Windows).
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
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
}

export interface Askpass {
  hook: GitAuthHook;
  /** Réponse du rendu à une demande (null : annulée). */
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
const CMD = '@set ELECTRON_RUN_AS_NODE=1\r\n@"%ARBOR_ASKPASS_NODE%" "%ARBOR_ASKPASS_MAIN%" %*\r\n';

export async function startAskpass(deps: AskpassDeps): Promise<Askpass> {
  const win = process.platform === 'win32';
  const dir = mkdtempSync(join(tmpdir(), 'arbor-askpass-'));
  chmodSync(dir, 0o700);
  const sh = join(dir, 'askpass.sh');
  const cmd = join(dir, 'askpass.cmd');
  const helper = join(dir, 'askpass-helper.js');
  writeFileSync(sh, SH, { mode: 0o700 });
  if (win) writeFileSync(cmd, CMD, { mode: 0o700 });
  // Copie hors de app.asar : le binaire en mode Node n'a pas à lire l'archive.
  copyFileSync(deps.helperSource ?? join(__dirname, 'askpass-helper.js'), helper);
  chmodSync(helper, 0o600);
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

  /** Demande au rendu ; null si annulée, expirée ou si la commande s'est terminée. */
  function ask(session: Session, partial: Omit<CredentialRequest, 'id' | 'operation' | 'repo'>): Promise<CredentialAnswer | null> {
    if (session.cancelled || session.done) return Promise.resolve(null);
    const request: CredentialRequest = { id: randomBytes(12).toString('hex'), operation: operationLabel(session.operation), repo: session.repo, ...partial };
    return new Promise((resolve) => {
      const timer = setTimeout(() => finishRequest(request.id, null), timeoutMs);
      pending.set(request.id, { request, session, resolve, timer });
      deps.send('credentialRequest', request);
    }).then((a) => {
      if (a === null) session.cancelled = true;
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

  async function credentialGet(session: Session, fields: CredentialFields): Promise<Reply> {
    const origin = credentialOrigin(fields);
    if (!origin) return { ok: true, out: '' };
    // 1. Compte connecté pour cet hôte.
    const account = deps.store.findForCredential({ protocol: fields.protocol, host: fields.host, username: fields.username });
    const secret = account ? deps.store.secret(account.id) : null;
    if (account && secret) {
      session.given.set(origin, account.id);
      return { ok: true, out: formatCredentialResponse({ username: gitUsername(account, secret.kind), password: secretValue(secret) }) };
    }
    // 2. Identifiants mémorisés pour la session.
    const mem = memory.get(origin);
    if (mem && (!fields.username || fields.username === mem.username)) return { ok: true, out: formatCredentialResponse(mem) };
    // 3. Demande interactive ; annulation : `quit=1`, Git s'arrête sans retomber sur GIT_ASKPASS.
    const a = await ask(session, {
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

  async function askpassPrompt(session: Session, prompt: string): Promise<Reply> {
    const c = classifyPrompt(prompt);
    const origin = credentialOrigin(c);
    const base = { protocol: c.protocol, host: c.host, username: c.username, prompt, userHelpers: [] as string[] };
    const cancelled: Reply = { ok: false, error: 'cancelled' };
    const secretOf = (a: CredentialAnswer | null): Reply => (a && a.kind === 'secret' ? { ok: true, out: a.value } : cancelled);
    switch (c.kind) {
      case 'https-username': {
        // Repli (l'assistant d'identifiants répond en principe avant) : un seul dialogue pour les deux invites.
        const a = await ask(session, { ...base, kind: 'https' });
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
        return secretOf(await ask(session, { ...base, kind: 'other' }));
      }
      case 'ssh-hostkey': {
        const a = await ask(session, { ...base, kind: 'ssh-hostkey', keyType: c.keyType, fingerprint: c.fingerprint });
        if (!a || a.kind !== 'confirm') return cancelled;
        return { ok: true, out: a.accept ? 'yes' : 'no' };
      }
      case 'ssh-passphrase':
      case 'ssh-password':
      case 'other': {
        const kind: CredentialKind = c.kind;
        return secretOf(await ask(session, { ...base, kind, ...(c.keyPath ? { keyPath: c.keyPath } : {}) }));
      }
    }
  }

  async function handle(msg: unknown): Promise<Reply> {
    if (!msg || typeof msg !== 'object') return { ok: false, error: 'refused' };
    const m = msg as Record<string, unknown>;
    if (typeof m.token !== 'string' || !sameSecret(m.token, token)) return { ok: false, error: 'refused' };
    const session = typeof m.session === 'string' ? sessions.get(m.session) : undefined;
    if (!session || session.done) return { ok: false, error: 'refused' };
    if (m.mode === 'credential' && typeof m.input === 'string') {
      const fields = parseCredentialFields(m.input);
      if (m.action === 'get') return credentialGet(session, fields);
      if (m.action === 'store') return credentialStore(session, fields);
      if (m.action === 'erase') return credentialErase(session, fields);
      return { ok: true, out: '' };
    }
    if (m.mode === 'askpass' && typeof m.prompt === 'string') return askpassPrompt(session, m.prompt);
    return { ok: false, error: 'refused' };
  }

  function onConnection(socket: Socket) {
    let buf = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
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
      let msg: unknown = null;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        // requête illisible : refusée
      }
      handle(msg)
        .catch((): Reply => ({ ok: false, error: 'refused' }))
        .then((reply) => {
          if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n');
        });
    });
  }

  const server: Server = createServer(onConnection);
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
        SSH_ASKPASS: win ? cmd : sh,
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
    if (kind !== 'https' && kind !== 'ssh-hostkey' && a.kind === 'secret' && validValue(a.value)) return finishRequest(id, { kind: 'secret', value: a.value });
    throw new Error('Réponse invalide pour cette demande d’identifiants.');
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
