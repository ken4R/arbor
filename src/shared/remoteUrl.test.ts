import { describe, expect, it } from 'vitest';
import { hostKey, normalizeInstanceUrl, parseRemoteUrl, projectPathFor, redactUrlCredentials } from './remoteUrl';

describe('parseRemoteUrl', () => {
  it('https, avec ou sans .git et / final', () => {
    const expected = { protocol: 'https', host: 'github.com', port: null, user: null, path: 'o/r', owner: 'o', name: 'r' };
    expect(parseRemoteUrl('https://github.com/o/r')).toEqual(expected);
    expect(parseRemoteUrl('https://github.com/o/r.git')).toEqual(expected);
    expect(parseRemoteUrl('https://github.com/o/r/')).toEqual(expected);
    expect(parseRemoteUrl('https://github.com/o/r.git/')).toEqual(expected);
    expect(parseRemoteUrl('  https://GitHub.COM/o/r.git  ')).toEqual(expected);
  });

  it('utilisateur, port et sous-groupes', () => {
    expect(parseRemoteUrl('https://u@h:8443/g/s/r.git')).toEqual({ protocol: 'https', host: 'h', port: 8443, user: 'u', path: 'g/s/r', owner: 'g/s', name: 'r' });
    expect(parseRemoteUrl('https://h/g/s/r.git/')).toMatchObject({ path: 'g/s/r', owner: 'g/s', name: 'r' });
    expect(parseRemoteUrl('https://h:443/o/r')).toMatchObject({ port: null });
  });

  it('jette le mot de passe', () => {
    const loc = parseRemoteUrl('https://u:secret@h/o/r.git');
    expect(loc).toMatchObject({ user: 'u', host: 'h' });
    expect(JSON.stringify(loc)).not.toContain('secret');
  });

  it('http en boucle locale', () => {
    expect(parseRemoteUrl('http://127.0.0.1:5000/g/r.git')).toEqual({ protocol: 'http', host: '127.0.0.1', port: 5000, user: null, path: 'g/r', owner: 'g', name: 'r' });
  });

  it('forme scp', () => {
    expect(parseRemoteUrl('git@github.com:o/r.git')).toEqual({ protocol: 'ssh', host: 'github.com', port: null, user: 'git', path: 'o/r', owner: 'o', name: 'r' });
    expect(parseRemoteUrl('org@ssh.dev.azure.com:v3/o/p/r')).toMatchObject({ host: 'ssh.dev.azure.com', user: 'org', path: 'v3/o/p/r', owner: 'v3/o/p', name: 'r' });
    // `2222` est un segment du chemin, pas un port.
    expect(parseRemoteUrl('git@h:2222/o/r')).toMatchObject({ host: 'h', port: null, path: '2222/o/r', owner: '2222/o' });
    expect(parseRemoteUrl('hote:o/r')).toMatchObject({ host: 'hote', user: null, path: 'o/r' });
    expect(parseRemoteUrl('git@faux.exemple:/tmp/forge/demo.git')).toMatchObject({ host: 'faux.exemple', path: 'tmp/forge/demo' });
  });

  it('ssh://, ~ et port par défaut', () => {
    expect(parseRemoteUrl('ssh://git@h:2222/g/s/r.git')).toEqual({ protocol: 'ssh', host: 'h', port: 2222, user: 'git', path: 'g/s/r', owner: 'g/s', name: 'r' });
    expect(parseRemoteUrl('ssh://h/~u/r')).toMatchObject({ protocol: 'ssh', user: null, path: 'u/r', owner: 'u', name: 'r' });
    expect(parseRemoteUrl('ssh://h:22/~u/r.git')).toMatchObject({ port: null, path: 'u/r' });
    expect(parseRemoteUrl('git+ssh://git@h/o/r')).toMatchObject({ protocol: 'ssh' });
  });

  it('git://', () => {
    expect(parseRemoteUrl('git://h/r')).toEqual({ protocol: 'git', host: 'h', port: null, user: null, path: 'r', owner: '', name: 'r' });
  });

  it('IPv6', () => {
    expect(parseRemoteUrl('ssh://git@[2001:db8::1]:22/o/r')).toMatchObject({ host: '2001:db8::1', port: null, path: 'o/r' });
    expect(parseRemoteUrl('http://[::1]:8080/o/r.git')).toMatchObject({ host: '::1', port: 8080 });
    expect(parseRemoteUrl('git@[::1]:o/r')).toMatchObject({ host: '::1', path: 'o/r' });
  });

  it('refuse les chemins locaux et les URL invalides', () => {
    for (const u of ['file:///x/r.git', '/x', './x', '../x', 'C:\\x', 'C:/x', 'c:x', '', '   ', '-oProxyCommand=x', 'https://h/o\nr', 'https://h', 'https://h/', 'ext::sh -c x', 'https://h a/o/r', 'https://h:99999/o/r', 'https://h/../r']) {
      expect(parseRemoteUrl(u), u).toBeNull();
    }
  });
});

describe('hostKey', () => {
  it('ajoute crochets IPv6 et port', () => {
    expect(hostKey('h', null)).toBe('h');
    expect(hostKey('h', 8443)).toBe('h:8443');
    expect(hostKey('::1', 5000)).toBe('[::1]:5000');
  });
});

describe('normalizeInstanceUrl', () => {
  it('exige https, garde le préfixe, retire le / final', () => {
    expect(normalizeInstanceUrl('https://GitLab.Exemple.org/gitlab/')).toEqual({ url: 'https://gitlab.exemple.org/gitlab', host: 'gitlab.exemple.org' });
    expect(normalizeInstanceUrl('https://gitlab.com')).toEqual({ url: 'https://gitlab.com', host: 'gitlab.com' });
    expect(normalizeInstanceUrl('https://h:443/')).toEqual({ url: 'https://h', host: 'h' });
    expect(normalizeInstanceUrl('https://h:8443')).toEqual({ url: 'https://h:8443', host: 'h:8443' });
    expect(normalizeInstanceUrl('git.exemple.org')).toEqual({ url: 'https://git.exemple.org', host: 'git.exemple.org' });
  });

  it('http seulement vers la boucle locale', () => {
    expect(normalizeInstanceUrl('http://127.0.0.1:5000')).toEqual({ url: 'http://127.0.0.1:5000', host: '127.0.0.1:5000' });
    expect(normalizeInstanceUrl('http://localhost:8080/gitlab')).toEqual({ url: 'http://localhost:8080/gitlab', host: 'localhost:8080' });
    expect(normalizeInstanceUrl('http://[::1]:8080')).toEqual({ url: 'http://[::1]:8080', host: '[::1]:8080' });
    expect(normalizeInstanceUrl('http://gitlab.exemple.org')).toHaveProperty('error');
  });

  it('refuse identifiants, requête, fragment et autres schémas', () => {
    for (const u of ['https://h:0', 'https://u:p@h', 'https://u@h', 'https://h/?a=1', 'https://h/#x', 'https://h?', 'ftp://h', 'mailto:x', '', 'https://h /x', 'https://h"x', 'https://h/../x']) {
      expect(normalizeInstanceUrl(u), u).toHaveProperty('error');
    }
  });
});

describe('redactUrlCredentials', () => {
  it('masque le mot de passe dans un texte', () => {
    expect(redactUrlCredentials("fatal: unable to access 'https://u:glpat-123@h/o/r.git/': 403")).toBe("fatal: unable to access 'https://u:•••@h/o/r.git/': 403");
    expect(redactUrlCredentials('a https://x:y@h b http://p:q@k')).toBe('a https://x:•••@h b http://p:•••@k');
    // Identifiant seul : peut être un jeton (https://ghp_…@github.com), masqué aussi.
    expect(redactUrlCredentials('https://ghp_abcdef@github.com/o/r/')).toBe('https://•••@github.com/o/r/');
    expect(redactUrlCredentials('https://u@h/o/r')).toBe('https://•••@h/o/r');
    // `@` dans le mot de passe : tout ce qui précède le dernier `@` de l'autorité est masqué.
    expect(redactUrlCredentials('https://u:p@ss@h/x')).toBe('https://u:•••@h/x');
    expect(redactUrlCredentials('https://u:p@ss@h/x@y')).toBe('https://u:•••@h/x@y');
    expect(redactUrlCredentials('https://h/o/r@main')).toBe('https://h/o/r@main');
    expect(redactUrlCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
  });
});

describe('projectPathFor', () => {
  it('retire le préfixe de chemin de l’instance pour http(s)', () => {
    const https = parseRemoteUrl('https://git.exemple.org/gitlab/g/s/p.git')!;
    expect(projectPathFor('https://git.exemple.org/gitlab', https)).toBe('g/s/p');
    expect(projectPathFor('https://git.exemple.org/autre', https)).toBeNull();
    expect(projectPathFor('https://git.exemple.org/GitLab', https)).toBe('g/s/p');
    expect(projectPathFor('https://github.com', parseRemoteUrl('https://github.com/o/r')!)).toBe('o/r');
  });

  it('SSH : pas de préfixe', () => {
    expect(projectPathFor('https://git.exemple.org/gitlab', parseRemoteUrl('git@git.exemple.org:g/p.git')!)).toBe('g/p');
  });
});
