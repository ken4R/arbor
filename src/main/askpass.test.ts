// Intégration : vrai `git` (crochet de git.ts) contre `scripts/fake-forge.cjs` et `scripts/fake-ssh.sh`, assistant
// construit par esbuild et lancé par le Node de Vitest. Configuration Git isolée (HOME temporaire,
// GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL) : l'assistant d'identifiants du poste ne fausse rien.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountStore, type AccountStore } from './accountStore';
import { startAskpass, type Askpass } from './askpass';
import { credentialHelpersFor, git, setGitAuthHook } from './git';
import { withOperation } from './opContext';
import type { CredentialAnswer, CredentialRequest } from '../shared/types';

const ROOT = resolve(__dirname, '../..');
const TOKEN = 'glpat-arbor-test-JETON';
const ENV_KEYS = ['HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'XDG_CONFIG_HOME'];

let tmp: string;
let home: string;
let globalConfig: string;
let forge: ChildProcess;
let base: string;
let askpass: Askpass;
let store: AccountStore;
let requests: CredentialRequest[];
let done: string[];
let respond: (req: CredentialRequest) => CredentialAnswer | null;
const savedEnv: Record<string, string | undefined> = {};

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function memoryStore(): AccountStore {
  return createAccountStore({
    file: join(tmp, 'accounts.json'),
    // Aucun trousseau : comptes en mémoire seulement (rien n'est écrit).
    crypto: { status: () => ({ encryption: 'unavailable', backend: null }), encrypt: () => '', decrypt: () => null },
    readFile: () => {
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
    writeFile: () => {
      throw new Error('aucune écriture attendue');
    },
    renameFile: () => {},
    now: () => 1000,
    randomId: () => `id${Math.random().toString(16).slice(2)}`,
  });
}

function addAccount(token = TOKEN) {
  return store.add({ provider: 'gitlab', instanceUrl: base, sshHosts: ['127.0.0.1'], login: 'arbor-test', name: null, avatarUrl: null, scopes: ['api'] }, { kind: 'pat', token });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'arbor-askpass-test-'));
  home = join(tmp, 'home');
  mkdirSync(home);
  globalConfig = join(home, '.gitconfig');
  writeFileSync(globalConfig, '');
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 't@exemple.org',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 't@exemple.org',
  });

  // Dépôt servi : groupe/sous/demo.git, un commit sur main.
  const src = join(tmp, 'src');
  mkdirSync(src);
  sh(src, 'init', '-q', '-b', 'main');
  writeFileSync(join(src, 'a.txt'), 'a\n');
  sh(src, 'add', 'a.txt');
  sh(src, 'commit', '-q', '-m', 'premier');
  mkdirSync(join(tmp, 'forge/groupe/sous'), { recursive: true });
  sh(tmp, 'clone', '-q', '--bare', src, join(tmp, 'forge/groupe/sous/demo.git'));

  const helperSource = join(tmp, 'askpass-helper.js');
  await build({ entryPoints: [join(ROOT, 'src/main/askpass-helper.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: helperSource, logLevel: 'silent' });

  forge = spawn(process.execPath, [join(ROOT, 'scripts/fake-forge.cjs'), '--port', '0', '--token', TOKEN, '--git-user', 'alice', '--git-password', 's3cret', '--repos', join(tmp, 'forge')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise<string>((res) => createInterface({ input: forge.stdout! }).once('line', res));
  base = JSON.parse(line).url;

  askpass = await startAskpass({
    store: { list: () => store.list(), findForCredential: (r) => store.findForCredential(r), secret: (id) => store.secret(id), markRejected: (id) => store.markRejected(id) },
    send: (event, payload) => {
      if (event === 'credentialDone') done.push((payload as { id: string }).id);
      if (event !== 'credentialRequest') return;
      const req = payload as CredentialRequest;
      requests.push(req);
      setImmediate(() => askpass.answer(req.id, respond(req)));
    },
    userHelpers: credentialHelpersFor,
    helperSource,
    nodePath: process.execPath,
  });
  setGitAuthHook(askpass.hook);
}, 30000);

afterAll(() => {
  setGitAuthHook(null);
  askpass?.stop();
  forge?.kill();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  store = memoryStore();
  requests = [];
  done = [];
  respond = () => null;
  writeFileSync(globalConfig, '');
  rmSync(join(home, '.git-credentials'), { force: true });
  askpass.forgetSession();
});

const repoUrl = () => `${base}/groupe/sous/demo.git`;
const lsRemote = () => withOperation({ operation: 'fetch', repo: tmp }, () => git(tmp, ['ls-remote', '--heads', repoUrl()]));
const alice: CredentialAnswer = { kind: 'https', username: 'alice', password: 's3cret', rememberForSession: false };

describe('assistant d’identifiants (HTTPS)', () => {
  it('compte connecté : jeton fourni sans demande', async () => {
    addAccount();
    expect(await lsRemote()).toMatch(/refs\/heads\/main/);
    expect(requests).toEqual([]);
  }, 20000);

  it('sans compte : une demande au rendu, puis succès', async () => {
    respond = () => alice;
    expect(await lsRemote()).toMatch(/refs\/heads\/main/);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'https', operation: 'Fetch', repo: tmp, protocol: 'http', host: new URL(base).host, userHelpers: [] });
  }, 20000);

  it('annulation : « Authentification annulée », sans second dialogue', async () => {
    await expect(lsRemote()).rejects.toThrow('Authentification annulée.');
    expect(requests).toHaveLength(1);
  }, 20000);

  it('mauvais mot de passe : erreur traduite, rien de mémorisé', async () => {
    respond = () => ({ ...alice, password: 'faux', rememberForSession: true });
    await expect(lsRemote()).rejects.toThrow(/Identifiants refusés par http:\/\/127\.0\.0\.1/);
    respond = () => null;
    await expect(lsRemote()).rejects.toThrow('Authentification annulée.');
    expect(requests).toHaveLength(2);
  }, 20000);

  it('mémoire de session, puis oubli', async () => {
    respond = () => ({ ...alice, rememberForSession: true });
    await lsRemote();
    await lsRemote();
    expect(requests).toHaveLength(1);
    askpass.forgetSession();
    await lsRemote();
    expect(requests).toHaveLength(2);
  }, 20000);

  it('assistant « store » de l’utilisateur : signalé, et il mémorise ce qui est saisi', async () => {
    writeFileSync(globalConfig, '[credential]\n\thelper = store\n');
    respond = () => alice;
    await lsRemote();
    expect(requests[0].userHelpers).toEqual(['store']);
    expect(readFileSync(join(home, '.git-credentials'), 'utf8')).toContain('alice');
  }, 20000);

  it('sécurité : avec « store » global et un compte, le jeton n’est jamais écrit dans ~/.git-credentials', async () => {
    writeFileSync(globalConfig, '[credential]\n\thelper = store\n');
    addAccount();
    const work = join(tmp, `clone-${Date.now()}`);
    await withOperation({ operation: 'cloneRepo', repo: null }, () => git(tmp, ['clone', '-q', '--', repoUrl(), work]));
    writeFileSync(join(work, 'b.txt'), 'b\n');
    await git(work, ['add', 'b.txt']);
    await git(work, ['commit', '-q', '-m', 'second']);
    await withOperation({ operation: 'push', repo: work }, () => git(work, ['push', '-q', 'origin', 'main']));
    expect(sh(join(tmp, 'forge/groupe/sous/demo.git'), 'log', '-1', '--format=%s', 'main').trim()).toBe('second');
    expect(requests).toEqual([]);
    const creds = join(home, '.git-credentials');
    expect(existsSync(creds) ? readFileSync(creds, 'utf8') : '').not.toContain(TOKEN);
    // Ni dans la configuration du clone.
    expect(readFileSync(join(work, '.git/config'), 'utf8')).not.toContain(TOKEN);
  }, 30000);

  it('jeton refusé par le serveur : compte « rejected », jamais supprimé', async () => {
    const account = addAccount('glpat-revoque');
    await expect(lsRemote()).rejects.toThrow(/Identifiants refusés/);
    expect(store.list()).toMatchObject([{ id: account.id, status: 'rejected' }]);
    // Le compte refusé n'est plus proposé : la commande suivante demande à l'utilisateur.
    respond = () => alice;
    await lsRemote();
    expect(requests).toHaveLength(1);
  }, 20000);
});

describe('canal local', () => {
  function rawRequest(socket: string, payload: object): Promise<{ ok: boolean; error?: string }> {
    return new Promise((res, rej) => {
      const s = connect(socket);
      let data = '';
      s.on('connect', () => s.write(JSON.stringify(payload) + '\n'));
      s.on('data', (d) => (data += d));
      s.on('error', rej);
      s.on('close', () => res(JSON.parse(data)));
    });
  }

  it('dossier 0700, socket et environnement', () => {
    const auth = askpass.hook(['fetch', 'origin'])!;
    try {
      const socket = auth.env.ARBOR_ASKPASS_SOCKET;
      if (process.platform !== 'win32') expect(statSync(join(socket, '..')).mode & 0o777).toBe(0o700);
      expect(auth.env.SSH_ASKPASS_REQUIRE).toBe('force');
      expect(auth.env.ARBOR_ASKPASS_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      for (const k of ['SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_TERMINAL_PROMPT']) expect(auth.env).not.toHaveProperty(k);
      expect(JSON.stringify(auth)).not.toMatch(/StrictHostKeyChecking|BatchMode/);
      expect(auth.prefixArgs.join(' ')).not.toContain(TOKEN);
    } finally {
      auth.done();
    }
  });

  it('commande locale : rien', () => {
    expect(askpass.hook(['status', '--porcelain=v2'])).toBeNull();
  });

  it('mauvais jeton de socket : refusé', async () => {
    const auth = askpass.hook(['fetch'])!;
    try {
      const r = await rawRequest(auth.env.ARBOR_ASKPASS_SOCKET, { token: '0'.repeat(64), session: auth.env.ARBOR_ASKPASS_SESSION, mode: 'askpass', prompt: 'Password: ' });
      expect(r).toEqual({ ok: false, error: 'refused' });
      expect(requests).toEqual([]);
    } finally {
      auth.done();
    }
  });

  it('session terminée : refusée', async () => {
    const auth = askpass.hook(['fetch'])!;
    auth.done();
    const r = await rawRequest(auth.env.ARBOR_ASKPASS_SOCKET, { token: auth.env.ARBOR_ASKPASS_TOKEN, session: auth.env.ARBOR_ASKPASS_SESSION, mode: 'askpass', prompt: 'Password: ' });
    expect(r).toEqual({ ok: false, error: 'refused' });
  });

  it('fin de la commande : demande en attente annulée et dialogue fermé', async () => {
    const auth = askpass.hook(['fetch'])!;
    // La commande se termine pendant que le dialogue est ouvert ; la réponse tardive est ignorée.
    respond = () => {
      auth.done();
      return { kind: 'secret', value: 'trop tard' };
    };
    const pending = new Promise<{ ok: boolean; error?: string }>((res) => {
      const s = connect(auth.env.ARBOR_ASKPASS_SOCKET);
      let data = '';
      s.on('connect', () => s.write(JSON.stringify({ token: auth.env.ARBOR_ASKPASS_TOKEN, session: auth.env.ARBOR_ASKPASS_SESSION, mode: 'askpass', prompt: 'Verification code: ' }) + '\n'));
      s.on('data', (d) => (data += d));
      s.on('close', () => res(JSON.parse(data)));
    });
    expect(await pending).toEqual({ ok: false, error: 'cancelled' });
    expect(done).toEqual([requests[0].id]);
  });

  it('réponse d’un type inattendu : refusée', async () => {
    let thrown: unknown = null;
    respond = (req) => {
      try {
        askpass.answer(req.id, { kind: 'secret', value: 'x' });
      } catch (e) {
        thrown = e;
      }
      return null;
    };
    await expect(lsRemote()).rejects.toThrow('Authentification annulée.');
    expect(String(thrown)).toMatch(/Réponse invalide/);
  }, 20000);
});

describe('SSH (fake-ssh.sh)', () => {
  const sshUrl = () => `git@faux.exemple:${join(tmp, 'forge/groupe/sous/demo.git')}`;
  const known = () => join(tmp, 'known');
  const fetchSsh = (env: Record<string, string> = {}) =>
    withOperation({ operation: 'fetch', repo: tmp }, () =>
      git(tmp, ['ls-remote', '--heads', sshUrl()], { env: { GIT_SSH_COMMAND: `sh ${join(ROOT, 'scripts/fake-ssh.sh')}`, FAKE_SSH_KNOWN: known(), FAKE_SSH_PASSPHRASE: 'phrase', ...env } }),
    );

  beforeEach(() => rmSync(known(), { force: true }));

  it('empreinte refusée : clé d’hôte non vérifiée', async () => {
    respond = () => ({ kind: 'confirm', accept: false });
    await expect(fetchSsh()).rejects.toThrow("Clé d'hôte SSH non vérifiée");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'ssh-hostkey', host: 'faux.exemple', keyType: 'ED25519', fingerprint: 'SHA256:dGVzdC1hcmJvci1mYXV4LXNzaC1jbGUtZWQyNTUxOQ' });
    expect(existsSync(known())).toBe(false);
  }, 20000);

  it('empreinte acceptée puis phrase de passe : succès', async () => {
    respond = (req) => (req.kind === 'ssh-hostkey' ? { kind: 'confirm', accept: true } : { kind: 'secret', value: 'phrase' });
    expect(await fetchSsh()).toMatch(/refs\/heads\/main/);
    expect(requests.map((r) => r.kind)).toEqual(['ssh-hostkey', 'ssh-passphrase']);
    expect(requests[1].keyPath).toBe(join(home, '.ssh/id_ed25519'));
    // Hôte connu : seule la phrase de passe est redemandée.
    requests = [];
    await fetchSsh();
    expect(requests.map((r) => r.kind)).toEqual(['ssh-passphrase']);
  }, 20000);

  it('mauvaise phrase de passe : clé SSH refusée', async () => {
    writeFileSync(known(), '');
    respond = () => ({ kind: 'secret', value: 'fausse' });
    await expect(fetchSsh()).rejects.toThrow('Clé SSH refusée par le serveur');
  }, 20000);

  it('phrase de passe annulée : « Authentification annulée »', async () => {
    writeFileSync(known(), '');
    let stderr = '';
    try {
      await fetchSsh();
    } catch (e) {
      stderr = (e as { stderr: string }).stderr;
      expect((e as Error).message).toBe('Authentification annulée.');
    }
    expect(stderr).toContain('arbor: authentification annulée');
    expect(requests).toHaveLength(1);
  }, 20000);

  it('clé d’hôte changée : refus sans question ni contournement', async () => {
    writeFileSync(known(), '');
    await expect(fetchSsh({ FAKE_SSH_CHANGED: '1' })).rejects.toThrow(/a changé depuis votre dernière connexion.*ssh-keygen -R faux\.exemple/);
    expect(requests).toEqual([]);
  }, 20000);
});
