#!/usr/bin/env bash
# Crée un dépôt de démonstration réaliste pour tester Arbor.
# Usage : scripts/demo-repo.sh <dossier> [--conflict | --conflict3]
set -euo pipefail

DIR=${1:?"Usage : $0 <dossier> [--conflict | --conflict3]"}
rm -rf "$DIR" "$DIR-remote.git" "$DIR-miroir.git"
mkdir -p "$DIR"
cd "$DIR"
git init -q -b main
git config user.name "Camille Martin"
git config user.email camille@example.com

c() { # fichier contenu auteur email message
  echo "$2" >> "$1"
  git add -A
  GIT_AUTHOR_NAME="$3" GIT_AUTHOR_EMAIL="$4" git commit -qm "$5"
}

c README.md "# Démo" "Camille Martin" camille@example.com "Initialisation du projet"
c app.js "console.log(1)" "Camille Martin" camille@example.com "Ajoute le point d'entrée"
git checkout -qb feature/login
c login.js "login()" "Léa Dubois" lea@example.com "Écran de connexion"
c login.js "validate()" "Léa Dubois" lea@example.com "Validation du formulaire"
git checkout -q main
c app.js "console.log(2)" "Camille Martin" camille@example.com "Corrige le démarrage"
git checkout -qb fix/typo
c README.md "typo" "Hugo Petit" hugo@example.com "Corrige une faute dans le README"
git checkout -q main
git merge -q --no-ff feature/login -m "Fusionne feature/login"
c app.js "console.log(3)" "Camille Martin" camille@example.com "Prépare la version 1.0"
git tag v1.0
git checkout -qb feature/api
c api.js "api()" "Hugo Petit" hugo@example.com "Client API"
git checkout -q main
c app.js "console.log(4)" "Léa Dubois" lea@example.com "Ajoute la télémétrie"
# Renommage suivi par l'historique d'un fichier
mkdir -p auth
git mv login.js auth/login.js
GIT_AUTHOR_NAME="Hugo Petit" GIT_AUTHOR_EMAIL=hugo@example.com git commit -qm "Range la connexion dans auth/"
c auth/login.js "logout()" "Léa Dubois" lea@example.com "Ajoute la déconnexion"

# Remote local + un commit non poussé
git clone -q --bare . "../$(basename "$DIR")-remote.git"
git remote add origin "../$(basename "$DIR")-remote.git"
git fetch -q origin
git branch -q -u origin/main
c app.js "console.log(5)" "Camille Martin" camille@example.com "Commit local non poussé"
c config.js "$(for i in $(seq 1 40); do echo "export const option$i = $i;"; done)" "Camille Martin" camille@example.com "Ajoute la configuration"

# Tags : annoté v1.1 sur le dernier commit poussé, léger (nom avec « / » et accent) sur la fusion
git tag -a v1.1 -m "Version 1.1

Connexion rangée dans auth/ et déconnexion." origin/main
git tag "jalon/été" ":/^Fusionne feature/login"

# Second remote (dépôt nu <dossier>-miroir.git), récupéré
git clone -q --bare "../$(basename "$DIR")-remote.git" "../$(basename "$DIR")-miroir.git"
git remote add miroir "../$(basename "$DIR")-miroir.git"
git fetch -q miroir

# Branche à réécrire (rebase interactif) : 5 commits, un fichier chacun (réordonnables sans conflit), dont un fixup!
git checkout -qb feature/historique
mkdir -p historique
c historique/journal.js "export const journal = [];" "Léa Dubois" lea@example.com "Ajoute le journal des modifications"
c historique/affichage.js "export function afficher() {}" "Léa Dubois" lea@example.com "Affiche l'historique"
c historique/journal.js "export const taille = 100;" "Léa Dubois" lea@example.com "fixup! Ajoute le journal des modifications"
c historique/pagination.js "export const parPage = 20;" "Hugo Petit" hugo@example.com "Pagine l'historique"
c historique/filtre.js "export function parAuteur() {}" "Hugo Petit" hugo@example.com "Filtre l'historique par auteur"
git checkout -q main

# Modifications en cours : un fichier modifié, un nouveau, un indexé
echo "modif" >> README.md
echo "nouveau" > notes.txt
echo "x" >> app.js
# Deux modifications éloignées de config.js (deux blocs non indexés) pour l'indexation partielle
sed -e 's/^export const option3 = 3;$/export const option3 = 30;/' -e 's/^export const option4 = 4;$/export const option4 = 40;/' \
  -e 's/^export const option35 = 35;$/export const option35 = 350;/' config.js > config.js.tmp && mv config.js.tmp config.js
git add app.js

if [[ "${2:-}" == "--conflict" ]]; then
  git stash -q --include-untracked
  git checkout -qb conflit HEAD~1
  echo "version A" > app.js && git commit -qam "Version A"
  git checkout -q main
  echo "version B" > app.js && git commit -qam "Version B"
  git merge conflit >/dev/null 2>&1 || true
elif [[ "${2:-}" == "--conflict3" ]]; then
  # Fusion de `conflit3` en cours : fusion.txt = changements sans conflit des deux côtés (lignes 3 et 36) et deux
  # blocs en conflit (lignes 12 et 24) ; obsolete.js = modifié ici (main), supprimé dans conflit3.
  git stash -q --include-untracked
  for i in $(seq 1 40); do echo "ligne $i"; done > fusion.txt
  printf 'export function ancien() {\n  return 1;\n}\n' > obsolete.js
  git add fusion.txt obsolete.js && git commit -qm "Ajoute fusion.txt et obsolete.js"
  git checkout -qb conflit3
  sed -e 's/^ligne 3$/ligne 3 (leur version)/' -e 's/^ligne 12$/ligne 12 : leur version/' -e 's/^ligne 24$/ligne 24 : leur version/' fusion.txt > fusion.tmp && mv fusion.tmp fusion.txt
  git rm -q obsolete.js
  git commit -qam "Leur version : fusion.txt, suppression d'obsolete.js"
  git checkout -q main
  sed -e 's/^ligne 12$/ligne 12 : ma version/' -e 's/^ligne 24$/ligne 24 : ma version/' -e 's/^ligne 36$/ligne 36 (ma version)/' fusion.txt > fusion.tmp && mv fusion.tmp fusion.txt
  printf 'export function ancien() {\n  return 2;\n}\n' > obsolete.js
  git commit -qam "Ma version : fusion.txt, obsolete.js modifié"
  git merge conflit3 >/dev/null 2>&1 || true
fi

echo "Dépôt de démo prêt : $(pwd)"
