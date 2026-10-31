---
name: demo-repo
description: Générer un dépôt Git de démonstration (branches, merge, tag, remote, commit non poussé, modifications en cours, conflit optionnel) pour tester Arbor.
---

# Dépôt de démonstration

```bash
scripts/demo-repo.sh <dossier>             # historique + remote + modifications en cours
scripts/demo-repo.sh <dossier> --conflict  # en plus : fusion en conflit sur app.js
```

Contenu :
- branches `main`, `feature/login` (fusionnée), `feature/api`, `fix/typo`, tag `v1.0` ;
- remote `origin` (dépôt nu `<dossier>-remote.git`) avec `main` en avance de 1 ;
- `README.md` modifié, `notes.txt` non suivi, `app.js` indexé ;
- avec `--conflict` : les modifications sont mises en stash et une fusion de `conflit` est en cours.

Le script supprime `<dossier>` s'il existe : ne jamais lui passer le dépôt Arbor lui-même ni un dossier de l'utilisateur. Utiliser un chemin temporaire.

Pour un cas non couvert (rebase en cours, HEAD détachée, dépôt vide…), partir de ce dépôt et ajouter les commandes `git` nécessaires plutôt que de modifier le script, sauf si le cas doit devenir standard.
