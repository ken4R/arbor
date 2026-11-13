// Traductions des erreurs d'authentification (bloc `identifiants` de GIT_ERRORS), sur les sorties réelles de Git
// 2.43 (poste local) et des versions récentes (CI : 2.56), et d'OpenSSH. Un test par variante protège l'ordre des
// entrées : les entrées précises passent avant les génériques (« injoignable »).
import { describe, expect, it } from 'vitest';
import { translateGitError } from './git';

const HELPER = '!"$ARBOR_GIT_HELPER" credential';

describe('translateGitError : identifiants', () => {
  it('annulation (assistant qui renvoie quit=1, askpass annulé)', () => {
    expect(translateGitError(`fatal: credential helper '${HELPER}' told us to quit`)).toBe('Authentification annulée.');
    expect(translateGitError('arbor: authentification annulée\nfatal: could not read Username for \'https://h.org\': terminal prompts disabled')).toBe('Authentification annulée.');
    // Phrase de passe annulée : ssh enchaîne sur « Permission denied » ; l'annulation l'emporte.
    expect(translateGitError('arbor: authentification annulée\ngit@h: Permission denied (publickey).\nfatal: Could not read from remote repository.')).toBe('Authentification annulée.');
  });

  it('assistant injoignable', () => {
    expect(translateGitError("arbor: Arbor injoignable\nfatal: could not read Username for 'https://h.org': terminal prompts disabled")).toMatch(/n'a pas répondu/);
  });

  it('403 : accès refusé, plus « injoignable » (bug corrigé)', () => {
    // Git 2.43
    expect(translateGitError("remote: Forbidden\nfatal: unable to access 'https://gitlab.exemple.org/g/r.git/': The requested URL returned error: 403")).toMatch(/^Accès refusé \(403\)/);
    // Git 2.46+ (sans ligne remote)
    expect(translateGitError("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n")).toMatch(/^Accès refusé \(403\)/);
  });

  it('vrais problèmes réseau : toujours « injoignable »', () => {
    expect(translateGitError("fatal: unable to access 'https://nope.invalid/r.git/': Could not resolve host: nope.invalid")).toMatch(/injoignable/);
    expect(translateGitError("fatal: unable to access 'http://127.0.0.1:9/r.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server")).toMatch(/injoignable/);
  });

  it('identifiants refusés (401)', () => {
    expect(translateGitError("fatal: Authentication failed for 'http://127.0.0.1:5000/g/r.git/'")).toBe(
      "Identifiants refusés par http://127.0.0.1:5000/g/r.git/ : vérifiez l'identifiant et le mot de passe (ou le jeton).",
    );
    // URL avec identifiants : masquée.
    expect(translateGitError("fatal: Authentication failed for 'https://bob:hunter2@h.org/r.git/'")).not.toContain('hunter2');
  });

  it('401 sans « Authentication failed », et git-lfs', () => {
    expect(translateGitError("fatal: unable to access 'https://h.org/r.git/': The requested URL returned error: 401")).toMatch(/^Identifiants absents ou refusés \(401\)/);
    // git-lfs 3.x (pre-push, lfs fetch/pull)
    expect(
      translateGitError('batch response: Authentication required: Authorization error: https://h.org/r.git/info/lfs/objects/batch\nCheck that you have proper access to the repository\nerror: failed to push some refs to \'https://h.org/r.git\''),
    ).toMatch(/^Identifiants absents ou refusés \(401\)/);
    expect(translateGitError('Error downloading object: a.bin (1234abc): Smudge error: Error downloading a.bin: batch response: Authentication required: Authorization error')).toMatch(/401/);
  });

  it('mots de passe refusés par l’hébergeur (GitHub, GitLab)', () => {
    const github =
      "remote: Support for password authentication was removed on August 13, 2021.\nremote: Please see https://docs.github.com/get-started/getting-started-with-git/about-remote-repositories#cloning-with-https-urls for information on currently recommended modes of authentication.\nfatal: Authentication failed for 'https://github.com/o/r.git/'";
    expect(translateGitError(github)).toMatch(/refuse les mots de passe/);
    const gitlab = "remote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect or you're required to use a token instead of a password.\nfatal: Authentication failed for 'https://gitlab.com/g/r.git/'";
    expect(translateGitError(gitlab)).toMatch(/refuse les mots de passe/);
    expect(translateGitError("remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/o/r.git/'")).toMatch(/refuse les mots de passe/);
  });

  it('identifiants requis (aucun assistant, pas de terminal)', () => {
    expect(translateGitError("fatal: could not read Username for 'https://h.org': terminal prompts disabled")).toBe(
      "Identifiants requis pour https://h.org : connectez un compte (Comptes…) ou configurez un gestionnaire d'identifiants Git.",
    );
    expect(translateGitError("fatal: could not read Password for 'https://alice@h.org': No such device or address")).toMatch(/^Identifiants requis pour https:\/\/•••@h\.org/);
  });

  it('dépôt introuvable', () => {
    expect(translateGitError("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found")).toMatch(/^Dépôt introuvable/);
    expect(translateGitError("remote: The project you were looking for could not be found or you don't have permission to view it.\nfatal: repository 'https://gitlab.com/g/r.git/' not found")).toMatch(/^Dépôt introuvable/);
    expect(translateGitError("fatal: unable to access 'https://h.org/r.git/': The requested URL returned error: 404")).toMatch(/^Dépôt introuvable/);
  });

  it('certificat', () => {
    expect(translateGitError("fatal: unable to access 'https://h.org/r.git/': SSL certificate problem: self-signed certificate in certificate chain")).toBe('Certificat du serveur non reconnu.');
    expect(translateGitError("fatal: unable to access 'https://h.org/r.git/': server certificate verification failed. CAfile: none CRLfile: none")).toBe('Certificat du serveur non reconnu.');
  });

  const READ_FAILED = '\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.';

  it('SSH : clé d’hôte inconnue refusée', () => {
    expect(translateGitError('Host key verification failed.' + READ_FAILED)).toBe("Clé d'hôte SSH non vérifiée (serveur inconnu ou empreinte refusée).");
  });

  it('SSH : clé d’hôte changée, sans contournement', () => {
    const out = `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
Someone could be eavesdropping on you right now (man-in-the-middle attack)!
It is also possible that a host key has just been changed.
The fingerprint for the ED25519 key sent by the remote host is
SHA256:abc.
Please contact your system administrator.
Add correct host key in /home/u/.ssh/known_hosts to get rid of this message.
Offending ED25519 key in /home/u/.ssh/known_hosts:3
  remove with:
  ssh-keygen -f "/home/u/.ssh/known_hosts" -R "github.com"
Host key for github.com has changed and you have requested strict checking.
Host key verification failed.${READ_FAILED}`;
    const msg = translateGitError(out);
    expect(msg).toMatch(/a changé depuis votre dernière connexion/);
    expect(msg).toContain('ssh-keygen -R github.com');
    expect(msg).not.toMatch(/StrictHostKeyChecking|yes/);
  });

  it('SSH : clé refusée', () => {
    expect(translateGitError('git@github.com: Permission denied (publickey).' + READ_FAILED)).toMatch(/^Clé SSH refusée/);
    expect(translateGitError('git@gitlab.com: Permission denied (publickey,keyboard-interactive).' + READ_FAILED)).toMatch(/^Clé SSH refusée/);
  });

  it('SSH : serveur injoignable', () => {
    expect(translateGitError('ssh: Could not resolve hostname faux.invalid: Name or service not known' + READ_FAILED)).toBe('Serveur SSH injoignable.');
    expect(translateGitError('ssh: connect to host h.org port 22: Connection refused' + READ_FAILED)).toBe('Serveur SSH injoignable.');
    expect(translateGitError('ssh: connect to host h.org port 22: Connection timed out' + READ_FAILED)).toBe('Serveur SSH injoignable.');
  });

  it('repli : URL avec identifiants masquée', () => {
    const msg = translateGitError("error: quelque chose d'inattendu pour https://u:glpat-SECRET@h.org/r.git");
    expect(msg).not.toContain('glpat-SECRET');
    expect(msg).toContain('https://u:•••@h.org/r.git');
  });
});
