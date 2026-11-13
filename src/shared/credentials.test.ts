import { describe, expect, it } from 'vitest';
import {
  ARBOR_HELPER,
  classifyPrompt,
  credentialArgs,
  credentialOrigin,
  effectiveHelpers,
  formatCredentialResponse,
  helperLabel,
  needsAuth,
  operationLabel,
  parseConfigEntries,
  parseCredentialFields,
  parseHostKeyPrompt,
  parseKeyPathPrompt,
} from './credentials';

describe('needsAuth', () => {
  it('reconnaît les commandes réseau', () => {
    for (const args of [['fetch', 'origin'], ['pull', '--ff-only'], ['push', '-u', 'origin', 'main'], ['clone', '--', 'u', 'd'], ['ls-remote', '--tags', 'origin']]) {
      expect(needsAuth(args)).toBe(true);
    }
  });
  it('saute les options globales', () => {
    expect(needsAuth(['-c', 'protocol.version=2', '--no-optional-locks', 'fetch'])).toBe(true);
    expect(needsAuth(['-C', '/x', '--literal-pathspecs', 'submodule', 'update', '--init'])).toBe(true);
    expect(needsAuth(['-c', 'fetch.x=1', 'status'])).toBe(false);
    expect(needsAuth(['--git-dir', 'push', 'log'])).toBe(false);
  });
  it('remote prune/update/show oui, remote add/remove non', () => {
    expect(needsAuth(['remote', 'prune', 'origin'])).toBe(true);
    expect(needsAuth(['remote', 'update'])).toBe(true);
    expect(needsAuth(['remote', '-v', 'show', 'origin'])).toBe(true);
    expect(needsAuth(['remote', 'add', 'o', 'u'])).toBe(false);
    expect(needsAuth(['remote', 'remove', 'o'])).toBe(false);
  });
  it('lfs fetch/pull/push oui, lfs ls-files/track non', () => {
    expect(needsAuth(['lfs', 'fetch', '--all'])).toBe(true);
    expect(needsAuth(['lfs', 'pull', '--include', 'a'])).toBe(true);
    expect(needsAuth(['lfs', 'push', 'origin', 'main'])).toBe(true);
    expect(needsAuth(['lfs', 'ls-files', '--long'])).toBe(false);
    expect(needsAuth(['lfs', 'track', '*.psd'])).toBe(false);
  });
  it('submodule sync/status non', () => {
    expect(needsAuth(['submodule', 'sync', '--recursive'])).toBe(false);
    expect(needsAuth(['submodule', 'status'])).toBe(false);
  });
  it('commandes locales et vides', () => {
    expect(needsAuth(['status', '--porcelain=v2'])).toBe(false);
    expect(needsAuth(['log', '--', 'fetch'])).toBe(false);
    expect(needsAuth([])).toBe(false);
  });
});

describe('parseCredentialFields', () => {
  it('lit les champs connus et ignore les autres (Git 2.46+)', () => {
    const input = 'capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=git.exemple.org:8443\npath=g/r.git\nusername=alice\nwwwauth[]=Basic realm="x"\nauthtype=Bearer\n\nignored=1\n';
    expect(parseCredentialFields(input)).toEqual({ protocol: 'https', host: 'git.exemple.org:8443', path: 'g/r.git', username: 'alice' });
  });
  it('accepte une valeur contenant « = » et des fins de ligne CRLF', () => {
    expect(parseCredentialFields('protocol=https\r\npassword=a=b\r\n')).toEqual({ protocol: 'https', password: 'a=b' });
  });
  it('vide', () => expect(parseCredentialFields('')).toEqual({}));
});

describe('formatCredentialResponse', () => {
  it('formate les lignes clé=valeur', () => {
    expect(formatCredentialResponse({ username: 'u', password: 'p=1', skip: undefined })).toBe('username=u\npassword=p=1\n');
  });
  it('refuse les sauts de ligne et NUL', () => {
    expect(() => formatCredentialResponse({ password: 'a\nhost=evil' })).toThrow();
    expect(() => formatCredentialResponse({ password: 'a\0' })).toThrow();
    expect(() => formatCredentialResponse({ password: 'a\r' })).toThrow();
  });
});

describe('credentialOrigin', () => {
  it('construit l’origine en minuscules', () => {
    expect(credentialOrigin({ protocol: 'HTTPS', host: 'Git.Exemple.org:8443' })).toBe('https://git.exemple.org:8443');
    expect(credentialOrigin({ protocol: 'https' })).toBeNull();
    expect(credentialOrigin({ protocol: 'a b', host: 'h' })).toBeNull();
  });
});

describe('credentialArgs', () => {
  it('assistant générique d’abord, puis remise à zéro et assistant d’Arbor par compte', () => {
    expect(credentialArgs([])).toEqual(['-c', `credential.helper=${ARBOR_HELPER}`]);
    expect(credentialArgs(['https://gitlab.exemple.org', 'http://127.0.0.1:5000', 'https://gitlab.exemple.org'])).toEqual([
      '-c',
      `credential.helper=${ARBOR_HELPER}`,
      '-c',
      'credential.https://gitlab.exemple.org.helper=',
      '-c',
      `credential.https://gitlab.exemple.org.helper=${ARBOR_HELPER}`,
      '-c',
      'credential.http://127.0.0.1:5000.helper=',
      '-c',
      `credential.http://127.0.0.1:5000.helper=${ARBOR_HELPER}`,
    ]);
  });
  it('écarte une origine dangereuse pour une clé de configuration', () => {
    expect(credentialArgs(['https://h x', 'https://h"', 'https://h=1', 'file:///x', 'https://h/path'])).toEqual(['-c', `credential.helper=${ARBOR_HELPER}`]);
  });
  it('la valeur de l’assistant est une chaîne constante', () => {
    expect(ARBOR_HELPER).toBe('!"$ARBOR_GIT_HELPER" credential');
  });
});

describe('operationLabel', () => {
  it('libellés connus et repli', () => {
    expect(operationLabel('fetch')).toBe('Fetch');
    expect(operationLabel('cloneRepo')).toBe('Clonage');
    expect(operationLabel('inconnu')).toBe('Opération Git');
    expect(operationLabel(null)).toBe('Opération Git');
  });
});

// Textes réels d'OpenSSH (8.9 : Ubuntu 22.04 ; 9.x : macOS, Git for Windows, Ubuntu 24.04).
const HOSTKEY_89 =
  "The authenticity of host 'github.com (140.82.121.4)' can't be established.\nED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\nThis key is not known by any other names\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
const HOSTKEY_9 =
  "The authenticity of host '[git.exemple.org]:2222 ([192.0.2.7]:2222)' can't be established.\nECDSA key fingerprint is SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM.\nThis host key is known by the following other names/addresses:\n    ~/.ssh/known_hosts:12: gitlab.exemple.org\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";

describe('parseHostKeyPrompt', () => {
  it('OpenSSH 8.9', () => {
    expect(parseHostKeyPrompt(HOSTKEY_89)).toEqual({ host: 'github.com', keyType: 'ED25519', fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' });
  });
  it('OpenSSH 9.x, port et autres noms', () => {
    expect(parseHostKeyPrompt(HOSTKEY_9)).toEqual({ host: '[git.exemple.org]:2222', keyType: 'ECDSA', fingerprint: 'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM' });
  });
  it('autre invite', () => expect(parseHostKeyPrompt("Enter passphrase for key '/k': ")).toBeNull());
  it('invite keyboard-interactive du serveur qui imite la question : reste « other »', () => {
    const fake = `(git@h.exemple) ${HOSTKEY_89}`;
    expect(parseHostKeyPrompt(fake)).toBeNull();
    expect(classifyPrompt(fake).kind).toBe('other');
    expect(parseHostKeyPrompt(`  ${HOSTKEY_89}`)).toBeNull();
    expect(parseHostKeyPrompt(`${HOSTKEY_89}\nVerification code: `)).toBeNull();
  });
});

describe('parseKeyPathPrompt', () => {
  it('chemin de la clé', () => {
    expect(parseKeyPathPrompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': ")).toBe('/home/u/.ssh/id_ed25519');
    expect(parseKeyPathPrompt("Enter passphrase for key '/home/u/.ssh/id rsa' (will confirm each use): ")).toBe('/home/u/.ssh/id rsa');
    expect(parseKeyPathPrompt('Enter passphrase for "/k": ')).toBe('/k');
    expect(parseKeyPathPrompt('Password: ')).toBeNull();
  });
});

describe('classifyPrompt', () => {
  it('invites HTTPS de Git', () => {
    expect(classifyPrompt("Username for 'https://git.exemple.org:8443': ")).toEqual({ kind: 'https-username', protocol: 'https', host: 'git.exemple.org:8443', username: null });
    expect(classifyPrompt("Password for 'https://alice@git.exemple.org': ")).toEqual({ kind: 'https-password', protocol: 'https', host: 'git.exemple.org', username: 'alice' });
  });
  it('clé d’hôte', () => {
    expect(classifyPrompt(HOSTKEY_89)).toMatchObject({ kind: 'ssh-hostkey', protocol: 'ssh', host: 'github.com', keyType: 'ED25519' });
  });
  it('phrase de passe', () => {
    expect(classifyPrompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': ")).toMatchObject({ kind: 'ssh-passphrase', keyPath: '/home/u/.ssh/id_ed25519' });
  });
  it('mot de passe SSH (password et keyboard-interactive)', () => {
    expect(classifyPrompt("git@git.exemple.org's password: ")).toEqual({ kind: 'ssh-password', protocol: 'ssh', host: 'git.exemple.org', username: 'git' });
    expect(classifyPrompt('(alice@h.exemple) Password: ')).toEqual({ kind: 'ssh-password', protocol: 'ssh', host: 'h.exemple', username: 'alice' });
  });
  it('autres invites', () => {
    expect(classifyPrompt('Verification code: ').kind).toBe('other');
    expect(classifyPrompt('Enter PIN for ED25519-SK key /k: ').kind).toBe('other');
  });
});

describe('effectiveHelpers', () => {
  const entries = parseConfigEntries(
    [
      'credential.helper\ncache --timeout=900',
      'credential.helper\nstore',
      'credential.https://git.exemple.org.helper\n',
      'credential.https://git.exemple.org.helper\nosxkeychain',
      'credential.https://*.wild.org.helper\nlibsecret',
      'credential.https://h.org/grp.helper\nmanager',
      'credential.usehttppath\ntrue',
    ]
      .map((r) => r + '\0')
      .join(''),
  );
  it('liste générique', () => expect(effectiveHelpers(entries, 'https://autre.org/x.git')).toEqual(['cache --timeout=900', 'store']));
  it('remise à zéro par une valeur vide pour un hôte', () => expect(effectiveHelpers(entries, 'https://git.exemple.org/g/r.git')).toEqual(['osxkeychain']));
  it('le port compte (443 implicite)', () => {
    expect(effectiveHelpers(entries, 'https://git.exemple.org:443/r')).toEqual(['osxkeychain']);
    expect(effectiveHelpers(entries, 'https://git.exemple.org:8443/r')).toEqual(['cache --timeout=900', 'store']);
  });
  it('joker et préfixe de chemin', () => {
    expect(effectiveHelpers(entries, 'https://git.wild.org/r')).toEqual(['cache --timeout=900', 'store', 'libsecret']);
    expect(effectiveHelpers(entries, 'https://h.org/grp/r.git')).toEqual(['cache --timeout=900', 'store', 'manager']);
    expect(effectiveHelpers(entries, 'https://h.org/grpx/r.git')).toEqual(['cache --timeout=900', 'store']);
  });
  it('URL invalide', () => expect(effectiveHelpers(entries, 'pas une url')).toEqual([]));
});

describe('helperLabel', () => {
  it('noms lisibles', () => {
    expect(helperLabel('store')).toBe('store');
    expect(helperLabel('cache --timeout=900')).toBe('cache');
    expect(helperLabel('/usr/lib/git-core/git-credential-libsecret')).toBe('libsecret');
    expect(helperLabel('"C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe"')).toBe('manager');
    expect(helperLabel('!f() { echo password=x; }; f')).toBe('assistant personnalisé');
  });
});
