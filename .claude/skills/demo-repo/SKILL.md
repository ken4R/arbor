---
name: demo-repo
description: Générer un dépôt Git de démonstration (branches, merge, tags légers et annotés, deux remotes, branche à réécrire, commit non poussé, modifications en cours, conflits optionnels) pour tester Arbor.
---

# Dépôt de démonstration

```bash
scripts/demo-repo.sh <dossier>              # historique + remotes + modifications en cours
scripts/demo-repo.sh <dossier> --conflict   # en plus : fusion en conflit sur app.js
scripts/demo-repo.sh <dossier> --conflict3  # en plus : fusion en conflit (blocs mêlés + suppression/modification)
```

Contenu :
- branches `main`, `feature/login` (fusionnée), `feature/api`, `fix/typo` ;
- `feature/historique` (depuis `main`) : 5 commits, un fichier `historique/*.js` chacun (réordonnables sans conflit), dont `fixup! Ajoute le journal des modifications` (pour le rebase interactif) ;
- tags : `v1.0` (léger), `v1.1` (annoté, sur `origin/main`), `jalon/été` (léger, sur la fusion de `feature/login`) ;
- remote `origin` (dépôt nu `<dossier>-remote.git`) avec `main` en avance de 2 ; remote `miroir` (dépôt nu `<dossier>-miroir.git`, mêmes branches, récupéré) ;
- `README.md` et `config.js` modifiés (deux blocs), `notes.txt` non suivi, `app.js` indexé ;
- avec `--conflict` : les modifications sont mises en stash et une fusion de `conflit` est en cours (`app.js`) ;
- avec `--conflict3` : modifications en stash, fusion de `conflit3` en cours : `fusion.txt` (40 lignes) a des changements sans conflit des deux côtés (ligne 3 : leur version, ligne 36 : ma version) et deux blocs en conflit (lignes 12 et 24) ; `obsolete.js` est modifié dans `main` et supprimé dans `conflit3` (`UD`, sans étage 3).

Le script supprime `<dossier>` s'il existe : ne jamais lui passer le dépôt Arbor lui-même ni un dossier de l'utilisateur. Utiliser un chemin temporaire.

Pour un cas non couvert (rebase en cours, HEAD détachée, dépôt vide…), partir de ce dépôt et ajouter les commandes `git` nécessaires plutôt que de modifier le script, sauf si le cas doit devenir standard.
