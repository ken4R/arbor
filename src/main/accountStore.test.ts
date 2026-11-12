// Magasin de comptes avec un chiffrement factice injecté et un vrai fichier temporaire (aucun Electron).
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccountStore, normalizeAccountsFile, type AccountMeta } from './accountStore';
import { writeFileAtomic } from './fsutil';
import type { SecretCrypto } from './secrets';
import type { AccountStorageStatus } from '../shared/types';

const TOKEN = 'glpat-SECRET-123456';

/** Chiffrement factice : inversion des octets + base64 (le jeton n'apparaît jamais tel quel). */
function fakeCrypto(encryption: AccountStorageStatus['encryption'] = 'available', key = 1): SecretCrypto & { set(e: AccountStorageStatus['encryption']): void } {
  let enc = encryption;
  return {
    set: (e) => (enc = e),
    status: () => ({ encryption: enc, backend: enc === 'weak' ? 'basic_text' : 'fake' }),
    encrypt: (obj) => Buffer.from(Buffer.from(`${key}:${JSON.stringify(obj)}`).map((b) => b ^ 0x5a)).toString('base64'),
    decrypt: (b64) => {
      const text = Buffer.from(Buffer.from(b64, 'base64').map((b) => b ^ 0x5a)).toString();
      if (!text.startsWith(`${key}:`)) throw new Error('illisible');
      return JSON.parse(text.slice(String(key).length + 1));
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(crypto: SecretCrypto = fakeCrypto(), dir = mkdtempSync(join(tmpdir(), 'arbor-accounts-'))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const file = join(dir, 'accounts.json');
  let n = 0;
  let clock = 1000;
  const warnings: string[] = [];
  const store = createAccountStore({
    file,
    crypto,
    readFile: (f) => readFileSync(f, 'utf8'),
    writeFile: (f, c) => writeFileAtomic(f, c, 0o600),
    renameFile: renameSync,
    now: () => clock++,
    randomId: () => `id${++n}`,
    warn: (m) => warnings.push(m),
  });
  return { store, file, dir, warnings };
}

const META: AccountMeta = {
  provider: 'gitlab',
  instanceUrl: 'http://127.0.0.1:5000/',
  sshHosts: ['127.0.0.1'],
  login: 'arbor-test',
  name: 'Arbor Test',
  avatarUrl: null,
  scopes: ['read_api'],
};

describe('createAccountStore', () => {
  it('ajoute, persiste en 0600, sans jeton en clair', () => {
    const { store, file } = setup();
    const a = store.add(META, { kind: 'pat', token: TOKEN });
    expect(a).toMatchObject({ id: 'id1', instanceUrl: 'http://127.0.0.1:5000', host: '127.0.0.1:5000', status: 'ok', persisted: true, authMethod: 'pat', missingScopes: ['write_repository'] });
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(JSON.parse(raw).accounts[0]).toMatchObject({ id: 'id1', login: 'arbor-test' });
    expect(store.secret('id1')).toEqual({ kind: 'pat', token: TOKEN });
  });

  it('relit le fichier dans un nouveau magasin', () => {
    const crypto = fakeCrypto();
    const first = setup(crypto);
    first.store.add(META, { kind: 'pat', token: TOKEN });
    const second = setup(crypto, first.dir);
    expect(second.store.list().map((a) => a.login)).toEqual(['arbor-test']);
    expect(second.store.secret('id1')).toEqual({ kind: 'pat', token: TOKEN });
  });

  it('chiffrement faible ou indisponible : en mémoire seulement, rien n’est écrit', () => {
    for (const enc of ['weak', 'unavailable'] as const) {
      const { store, file } = setup(fakeCrypto(enc));
      const a = store.add(META, { kind: 'pat', token: TOKEN });
      expect(a.persisted).toBe(false);
      expect(existsSync(file)).toBe(false);
      expect(store.secret(a.id)).toEqual({ kind: 'pat', token: TOKEN });
      expect(store.storage().encryption).toBe(enc);
    }
  });

  it('met de côté un fichier corrompu', () => {
    const { store, file, warnings } = setup();
    writeFileSync(file, '{ pas du json');
    expect(store.list()).toEqual([]);
    expect(existsSync(`${file}.corrupt`)).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).not.toContain('pas du json');
  });

  it('secret illisible : compte gardé en « rejected », sans secret', () => {
    const first = setup(fakeCrypto('available', 1));
    first.store.add(META, { kind: 'pat', token: TOKEN });
    const second = setup(fakeCrypto('available', 2), first.dir);
    expect(second.store.list()[0]).toMatchObject({ login: 'arbor-test', status: 'rejected', secretUnreadable: true, persisted: true });
    expect(second.store.secret('id1')).toBeNull();
    expect(second.store.findForCredential({ protocol: 'http', host: '127.0.0.1:5000' })).toBeNull();
    // Reconnexion : nouveau secret, le compte redevient « ok ».
    expect(second.store.update('id1', { scopes: ['api'] }, { kind: 'pat', token: 'nouveau' })).toMatchObject({ status: 'ok', missingScopes: [] });
    expect(second.store.secret('id1')).toEqual({ kind: 'pat', token: 'nouveau' });
  });

  it('findForCredential, markRejected et onChange', () => {
    const { store, file } = setup();
    const seen: string[][] = [];
    const off = store.onChange((accounts) => seen.push(accounts.map((a) => `${a.login}:${a.status}`)));
    store.add(META, { kind: 'pat', token: TOKEN });
    expect(store.findForCredential({ protocol: 'http', host: '127.0.0.1:5000', username: 'arbor-test' })?.id).toBe('id1');
    expect(store.findForCredential({ protocol: 'http', host: '127.0.0.1:5000', username: 'bob' })).toBeNull();
    store.markRejected('id1');
    store.markRejected('id1'); // sans effet la seconde fois
    // Un jeton refusé n'est plus proposé à Git.
    expect(store.findForCredential({ protocol: 'http', host: '127.0.0.1:5000' })).toBeNull();
    expect(store.list()[0].secretUnreadable).toBe(false);
    expect(store.list()[0].status).toBe('rejected');
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts[0].status).toBe('rejected');
    expect(seen).toEqual([['arbor-test:ok'], ['arbor-test:rejected']]);
    off();
    store.remove('id1');
    expect(seen.length).toBe(2);
    expect(store.list()).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts).toEqual([]);
  });

  it('refuse une instance invalide et un compte inconnu', () => {
    const { store } = setup();
    expect(() => store.add({ ...META, instanceUrl: 'http://gitlab.exemple.org' }, { kind: 'pat', token: TOKEN })).toThrow(/https/);
    expect(() => store.remove('absent')).toThrow(/introuvable/);
    expect(store.secret('absent')).toBeNull();
  });
});

describe('createAccountStore : disque préservé', () => {
  it('weak + entrée persistée + update : l’entrée chiffrée reste sur disque, le nouveau jeton en mémoire', () => {
    const crypto = fakeCrypto('available');
    const first = setup(crypto);
    first.store.add(META, { kind: 'pat', token: TOKEN });
    const before = readFileSync(first.file, 'utf8');
    crypto.set('weak');
    const second = setup(crypto, first.dir);
    // Trousseau indisponible : distinct d'un jeton refusé.
    expect(second.store.list()[0]).toMatchObject({ status: 'rejected', secretUnreadable: true, persisted: true });
    const updated = second.store.update('id1', { scopes: ['api'] }, { kind: 'pat', token: 'nouveau-jeton' });
    expect(updated).toMatchObject({ status: 'ok', secretUnreadable: false, persisted: false, missingScopes: [] });
    expect(second.store.secret('id1')).toEqual({ kind: 'pat', token: 'nouveau-jeton' });
    expect(readFileSync(first.file, 'utf8')).toBe(before);
    expect(readFileSync(first.file, 'utf8')).not.toContain('nouveau-jeton');
    // Trousseau revenu (session suivante) : l'ancien jeton chiffré est toujours là.
    crypto.set('available');
    const third = setup(crypto, first.dir);
    expect(third.store.secret('id1')).toEqual({ kind: 'pat', token: TOKEN });
  });

  it('chiffrement en échec (accès au trousseau refusé) : compte en mémoire, avertissement fixe', () => {
    const crypto = { ...fakeCrypto(), encrypt: () => { throw new Error(`refus ${TOKEN}`); } };
    const { store, file, warnings } = setup(crypto);
    expect(store.add(META, { kind: 'pat', token: TOKEN })).toMatchObject({ persisted: false, status: 'ok' });
    expect(existsSync(file)).toBe(false);
    expect(warnings.join('\n')).not.toContain(TOKEN);
    expect(warnings.length).toBe(1);
  });

  it('version de fichier inconnue : lecture seule, fichier intact', () => {
    const { store, file, warnings } = setup();
    const future = JSON.stringify({ version: 2, accounts: [{ futur: true }] });
    writeFileSync(file, future);
    expect(store.list()).toEqual([]);
    store.add(META, { kind: 'pat', token: TOKEN });
    expect(readFileSync(file, 'utf8')).toBe(future);
    expect(store.list()[0]).toMatchObject({ login: 'arbor-test', persisted: false });
    expect(warnings.length).toBe(1);
  });

  it('erreur de lecture autre que ENOENT : lecture seule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arbor-accounts-'));
    dirs.push(dir);
    const writes: string[] = [];
    const store = createAccountStore({
      file: join(dir, 'accounts.json'),
      crypto: fakeCrypto(),
      readFile: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      writeFile: (f) => writes.push(f),
      renameFile: () => {},
      now: () => 1,
      randomId: () => 'x',
    });
    expect(store.add(META, { kind: 'pat', token: TOKEN }).persisted).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('createAccountStore : identité', () => {
  it('upsert met à jour le compte de même instance et même login au lieu de le dupliquer', () => {
    const { store } = setup();
    const a = store.upsert(META, { kind: 'pat', token: TOKEN });
    expect(a.created).toBe(true);
    const b = store.upsert({ ...META, instanceUrl: 'http://127.0.0.1:5000', login: 'ARBOR-test', scopes: ['api'] }, { kind: 'pat', token: 'autre' });
    expect(b).toMatchObject({ created: false, account: { id: a.account.id, missingScopes: [] } });
    expect(store.list().length).toBe(1);
    expect(store.secret(a.account.id)).toEqual({ kind: 'pat', token: 'autre' });
    expect(store.findByIdentity('http://127.0.0.1:5000/', 'arbor-test')?.id).toBe(a.account.id);
    expect(store.findByIdentity('http://127.0.0.1:5001', 'arbor-test')).toBeNull();
    // Autre login sur la même instance : nouveau compte.
    expect(store.upsert({ ...META, login: 'bob' }, { kind: 'pat', token: 'b' }).created).toBe(true);
    expect(store.list().length).toBe(2);
  });
});

describe('normalizeAccountsFile', () => {
  const good = { id: 'a1', provider: 'github', instanceUrl: 'https://github.com/', host: 'faux', sshHosts: ['github.com', 'x y'], login: 'octo', secret: 'Y2lwaGVy', scopes: ['repo', 3] };

  it('assainit les entrées', () => {
    expect(normalizeAccountsFile({ version: 1, accounts: [good] })).toEqual([
      {
        id: 'a1',
        provider: 'github',
        instanceUrl: 'https://github.com',
        host: 'github.com',
        sshHosts: ['github.com'],
        login: 'octo',
        name: null,
        avatarUrl: null,
        scopes: ['repo'],
        authMethod: 'pat',
        status: 'ok',
        addedAt: 0,
        validatedAt: 0,
        secret: 'Y2lwaGVy',
      },
    ]);
  });

  it('écarte les entrées invalides et les doublons', () => {
    expect(normalizeAccountsFile(undefined)).toEqual([]);
    expect(normalizeAccountsFile({ accounts: 'x' })).toEqual([]);
    const bad = [
      { ...good, id: 'b1', provider: 'bitbucket' },
      { ...good, id: 'b2', instanceUrl: 'http://exemple.org' },
      { ...good, id: 'b3', login: '' },
      { ...good, id: 'b4', secret: '' },
      { ...good, id: 'b 5' },
      good,
      { ...good, login: 'doublon' },
    ];
    expect(normalizeAccountsFile({ accounts: bad }).map((a) => a.login)).toEqual(['octo']);
  });
});
