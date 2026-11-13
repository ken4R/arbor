#!/bin/sh
# Faux transport SSH pour les tests (GIT_SSH_COMMAND="sh scripts/fake-ssh.sh") : aucune connexion réseau.
# Il pose les mêmes questions qu'OpenSSH, par "$SSH_ASKPASS", avec les textes exacts d'OpenSSH 9.x, puis lance la
# commande demandée par Git (`git-upload-pack '/chemin'`) en local.
#
#   FAKE_SSH_KNOWN       fichier « known_hosts » factice (défaut : $HOME/.fake-ssh-known) ; s'il n'existe pas, la
#                        clé d'hôte est inconnue et doit être confirmée ; « yes » (ou l'empreinte) le crée.
#   FAKE_SSH_PASSPHRASE  si défini : phrase de passe attendue pour la clé ~/.ssh/id_ed25519.
#   FAKE_SSH_CHANGED=1   clé d'hôte changée : refus immédiat, comme OpenSSH (aucune question).
#
# Git sonde d'abord la variante avec `-G` : on répond comme OpenSSH (succès), Git passe alors `-o SendEnv=…`, `-p`.

FINGERPRINT='SHA256:dGVzdC1hcmJvci1mYXV4LXNzaC1jbGUtZWQyNTUxOQ'
known=${FAKE_SSH_KNOWN:-$HOME/.fake-ssh-known}

host=
while [ $# -gt 0 ]; do
  case "$1" in
    -G) exit 0 ;;
    -o|-p|-l|-i|-F|-J) shift 2 ;;
    -*) shift ;;
    *) host=$1; shift; break ;;
  esac
done
user=git
case "$host" in *@*) user=${host%%@*}; host=${host#*@} ;; esac
command=$*

if [ "${FAKE_SSH_CHANGED:-}" = 1 ]; then
  cat >&2 <<EOF
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
Someone could be eavesdropping on you right now (man-in-the-middle attack)!
It is also possible that a host key has just been changed.
The fingerprint for the ED25519 key sent by the remote host is
SHA256:Y2hhbmdlZC1hcmJvci1mYXV4LXNzaC1jbGUtZWQyNTUxOQ.
Please contact your system administrator.
Add correct host key in $known to get rid of this message.
Offending ED25519 key in $known:1
  remove with:
  ssh-keygen -f "$known" -R "$host"
Host key for $host has changed and you have requested strict checking.
Host key verification failed.
EOF
  exit 255
fi

ask() {
  [ -n "${SSH_ASKPASS:-}" ] || return 1
  "$SSH_ASKPASS" "$1"
}

if [ ! -f "$known" ]; then
  prompt="The authenticity of host '$host (192.0.2.10)' can't be established.
ED25519 key fingerprint is $FINGERPRINT.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])? "
  answer=$(ask "$prompt") || answer=
  if [ "$answer" = yes ] || [ "$answer" = "$FINGERPRINT" ]; then
    : > "$known"
    echo "Warning: Permanently added '$host' (ED25519) to the list of known hosts." >&2
  else
    echo "Host key verification failed." >&2
    exit 255
  fi
fi

if [ -n "${FAKE_SSH_PASSPHRASE+x}" ]; then
  phrase=$(ask "Enter passphrase for key '$HOME/.ssh/id_ed25519': ") || phrase=
  if [ "$phrase" != "$FAKE_SSH_PASSPHRASE" ]; then
    echo "$user@$host: Permission denied (publickey)." >&2
    exit 255
  fi
fi

exec sh -c "$command"
