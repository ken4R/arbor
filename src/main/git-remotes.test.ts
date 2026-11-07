// Gestion des remotes sur un vrai dépôt temporaire (aucun réseau : remotes locaux ou URL jamais contactées).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { remoteOf } from '../renderer/actions';
import { addRemote, fetchRemote, parseConfigValues, pruneRemote, remoteConfig, remoteUrlError, removeRemote, renameRemote, setRemoteUrl, snapshot, translateGitError } from './git';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'arbor-remotes-'));
  dirs.push(dir);
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  sh('init', '-q');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'user.name', 'Test');
  sh('commit', '-q', '--allow-empty', '-m', 'base');
  return { dir, sh };
}

/** Dépôt nu local avec une branche `main`, utilisable comme remote. */
function bareWithMain() {
  const src = repo();
  const bare = mkdtempSync(join(tmpdir(), 'arbor-remotes-bare-'));
  dirs.push(bare);
  execFileSync('git', ['init', '-q', '--bare', bare]);
  src.sh('push', '-q', bare, 'HEAD:refs/heads/main');
  src.sh('push', '-q', bare, 'HEAD:refs/heads/temp');
  return bare;
}

describe('parseConfigValues', () => {
  it('découpe une sortie --null', () => {
    expect(parseConfigValues('/a\0/b c\0')).toEqual(['/a', '/b c']);
  });
  it('clé absente : liste vide', () => {
    expect(parseConfigValues('')).toEqual([]);
  });
});

describe('remoteUrlError', () => {
  it('accepte les URL habituelles', () => {
    expect(remoteUrlError('https://exemple.org/projet.git')).toBeNull();
    expect(remoteUrlError('git@exemple.org:moi/projet.git')).toBeNull();
    expect(remoteUrlError('/chemin avec espaces/dépôt')).toBeNull();
  });
  it('refuse une URL vide, prise pour une option ou multiligne', () => {
    expect(remoteUrlError('  ')).not.toBeNull();
    expect(remoteUrlError('--upload-pack=touch')).not.toBeNull();
    expect(remoteUrlError('/a\n/b')).not.toBeNull();
  });
});

describe('translateGitError (remotes)', () => {
  it('traduit les erreurs de remote', () => {
    expect(translateGitError('error: remote origin already exists.')).toBe('Le remote « origin » existe déjà.');
    expect(translateGitError("error: No such remote: 'zz'")).toContain('« zz » n\'existe pas');
    expect(translateGitError("error: No such remote 'zz'")).toContain('« zz » n\'existe pas');
  });
});

describe('remoteOf', () => {
  it('rattache une branche au plus long remote qui la préfixe', () => {
    const remotes = [{ name: 'a' }, { name: 'a/b' }, { name: 'origin' }];
    expect(remoteOf(remotes, 'a/b/x')).toBe('a/b');
    expect(remoteOf(remotes, 'a/x')).toBe('a');
    expect(remoteOf(remotes, 'a/bc')).toBe('a');
    expect(remoteOf(remotes, 'origin/main')).toBe('origin');
    expect(remoteOf(remotes, 'autre/main')).toBeNull();
  });
});

describe('validation des noms de remote', () => {
  it.each(['-x', 'a b', 'a..b', '', 'fin/', 'x.lock'])('refuse « %s »', async (name) => {
    const { dir } = repo();
    await expect(addRemote(dir, name, '/nulle-part', null, false)).rejects.toThrow(/n'est pas un nom de remote valide/);
  });

  it('accepte accents et barre oblique', async () => {
    const { dir, sh } = repo();
    await addRemote(dir, 'été', '/nulle-part', null, false);
    await addRemote(dir, 'a/b', '/ailleurs', null, false);
    expect(sh('remote').split('\n').filter(Boolean).sort()).toEqual(['a/b', 'été']);
  });

  it('refuse une URL prise pour une option', async () => {
    const { dir } = repo();
    await expect(addRemote(dir, 'x', '--upload-pack=touch /tmp/pwn', null, false)).rejects.toThrow(/URL valide/);
  });

  it('nom déjà pris : message en français', async () => {
    const { dir } = repo();
    await addRemote(dir, 'x', '/a', null, false);
    await expect(addRemote(dir, 'x', '/b', null, false)).rejects.toThrow('Le remote « x » existe déjà.');
  });
});

describe('cycle de vie d’un remote', () => {
  it('ajoute (avec push distinct), renomme, modifie et supprime', async () => {
    const { dir, sh } = repo();
    await addRemote(dir, 'miroir2', '/fetch', '/push', false);
    expect(sh('remote', '-v')).toBe('miroir2\t/fetch (fetch)\nmiroir2\t/push (push)\n');

    await renameRemote(dir, 'miroir2', 'miroir3');
    expect(sh('remote')).toBe('miroir3\n');

    await setRemoteUrl(dir, 'miroir3', '/fetch2', false);
    expect(await remoteConfig(dir, 'miroir3')).toEqual({ urls: ['/fetch2'], pushUrls: ['/push'] });

    // Champ push vidé : pushurl retirée, le push reprend l'URL de fetch.
    await setRemoteUrl(dir, 'miroir3', null, true);
    expect(await remoteConfig(dir, 'miroir3')).toEqual({ urls: ['/fetch2'], pushUrls: [] });
    expect(sh('remote', '-v')).toBe('miroir3\t/fetch2 (fetch)\nmiroir3\t/fetch2 (push)\n');
    // Déjà absente : sans effet ni erreur.
    await setRemoteUrl(dir, 'miroir3', '', true);

    await removeRemote(dir, 'miroir3');
    expect(sh('remote')).toBe('');
  });

  it('remoteConfig renvoie les valeurs brutes, avant insteadOf', async () => {
    const { dir, sh } = repo();
    sh('config', 'url.https://exemple.org/.insteadOf', 'ex:');
    await addRemote(dir, 'r', 'ex:projet.git', null, false);
    const snap = await snapshot(dir);
    expect(snap.remotes).toEqual([{ name: 'r', fetchUrl: 'https://exemple.org/projet.git', pushUrl: null }]);
    expect(await remoteConfig(dir, 'r')).toEqual({ urls: ['ex:projet.git'], pushUrls: [] });
  });

  it('refuse de modifier une URL multiple', async () => {
    const { dir, sh } = repo();
    await addRemote(dir, 'r', '/a', null, false);
    sh('config', '--add', 'remote.r.url', '/b');
    await expect(setRemoteUrl(dir, 'r', '/c', false)).rejects.toThrow(/plusieurs URL/);
  });

  it('remote absent : message en français', async () => {
    const { dir } = repo();
    await expect(removeRemote(dir, 'zz')).rejects.toThrow('« zz » n\'existe pas');
  });

  it('fetch et prune d’un seul remote', async () => {
    const bare = bareWithMain();
    const { dir, sh } = repo();
    await addRemote(dir, 'local', bare, null, true);
    expect(sh('branch', '-r', '--format=%(refname:short)').split('\n').filter(Boolean).sort()).toEqual(['local/main', 'local/temp']);

    execFileSync('git', ['update-ref', '-d', 'refs/heads/temp'], { cwd: bare });
    await pruneRemote(dir, 'local');
    expect(sh('branch', '-r', '--format=%(refname:short)').trim()).toBe('local/main');

    execFileSync('git', ['update-ref', 'refs/heads/nouvelle', 'refs/heads/main'], { cwd: bare });
    await fetchRemote(dir, 'local');
    expect(sh('branch', '-r', '--format=%(refname:short)').split('\n').filter(Boolean).sort()).toEqual(['local/main', 'local/nouvelle']);
  });
});
