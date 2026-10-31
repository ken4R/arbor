#!/usr/bin/env bash
# Crée un dépôt de démonstration réaliste pour tester Arbor.
# Usage : scripts/demo-repo.sh <dossier> [--conflict]
set -euo pipefail

DIR=${1:?"Usage : $0 <dossier> [--conflict]"}
rm -rf "$DIR" "$DIR-remote.git"
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

# Remote local + un commit non poussé
git clone -q --bare . "../$(basename "$DIR")-remote.git"
git remote add origin "../$(basename "$DIR")-remote.git"
git fetch -q origin
git branch -q -u origin/main
c app.js "console.log(5)" "Camille Martin" camille@example.com "Commit local non poussé"

# Modifications en cours : un fichier modifié, un nouveau, un indexé
echo "modif" >> README.md
echo "nouveau" > notes.txt
echo "x" >> app.js
git add app.js

if [[ "${2:-}" == "--conflict" ]]; then
  git stash -q --include-untracked
  git checkout -qb conflit HEAD~1
  echo "version A" > app.js && git commit -qam "Version A"
  git checkout -q main
  echo "version B" > app.js && git commit -qam "Version B"
  git merge conflit >/dev/null 2>&1 || true
fi

echo "Dépôt de démo prêt : $(pwd)"
