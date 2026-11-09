---
name: demo-repo
description: Générer un dépôt Git de démonstration (branches, merge, tags légers et annotés, deux remotes, branche à réécrire, commit non poussé, modifications en cours, conflits, sous-modules et LFS optionnels) pour tester Arbor.
---

# Dépôt de démonstration

```bash
scripts/demo-repo.sh <dossier>               # historique + remotes + modifications en cours
scripts/demo-repo.sh <dossier> --conflict    # en plus : fusion en conflit sur app.js
scripts/demo-repo.sh <dossier> --conflict3   # en plus : fusion en conflit (blocs mêlés + suppression/modification)
scripts/demo-repo.sh <dossier> --submodules  # en plus : deux sous-modules (vendor/lib, vendor/outils)
scripts/demo-repo.sh <dossier> --lfs         # en plus : fichiers suivis par Git LFS
scripts/demo-repo.sh <dossier> --submodules --lfs --conflict   # les options se combinent
```

Options combinables dans n'importe quel ordre, sauf `--conflict` et `--conflict3` qui s'excluent (une seule fusion en cours). Sans option, le dépôt est identique à celui des versions précédentes du script.

Contenu :
- branches `main`, `feature/login` (fusionnée), `feature/api`, `fix/typo` ;
- `feature/historique` (depuis `main`) : 5 commits, un fichier `historique/*.js` chacun (réordonnables sans conflit), dont `fixup! Ajoute le journal des modifications` (pour le rebase interactif) ;
- tags : `v1.0` (léger), `v1.1` (annoté, sur `origin/main`), `jalon/été` (léger, sur la fusion de `feature/login`) ;
- remote `origin` (dépôt nu `<dossier>-remote.git`) avec `main` en avance de 2 ; remote `miroir` (dépôt nu `<dossier>-miroir.git`, mêmes branches, récupéré) ;
- `README.md` et `config.js` modifiés (deux blocs), `notes.txt` non suivi, `app.js` indexé ;
- avec `--conflict` : les modifications sont mises en stash et une fusion de `conflit` est en cours (`app.js`) ;
- avec `--conflict3` : modifications en stash, fusion de `conflit3` en cours : `fusion.txt` (40 lignes) a des changements sans conflit des deux côtés (ligne 3 : leur version, ligne 36 : ma version) et deux blocs en conflit (lignes 12 et 24) ; `obsolete.js` est modifié dans `main` et supprimé dans `conflit3` (`UD`, sans étage 3) ;
- avec `--submodules` : dépôts nus `<dossier>-lib.git` (3 commits) et `<dossier>-outils.git` (1 commit) ; deux commits non poussés sur `main` (« Ajoute le sous-module vendor/lib », « … vendor/outils », donc `main` en avance de 4) ; `vendor/lib` est extrait sur le commit précédent celui attendu et a un fichier modifié (`git submodule status` : `+`, `git status --porcelain=v2` : `1 .M SCM.`) ; `vendor/outils` n'est pas initialisé (`-`, dossier vide). Les URL sont relatives (`../<nom>-lib.git`) : pour cloner ou initialiser un sous-module local, Git exige `-c protocol.file.allow=always` sur la commande (ne jamais l'écrire dans une configuration) ;
- avec `--lfs` (si `git lfs version` réussit, sinon « git-lfs absent : partie LFS ignorée » et le reste est créé normalement) : hooks LFS installés localement, motifs `*.bin` et `assets/*.psd` dans `.gitattributes`, commit « Ajoute les fichiers binaires (LFS) » publié (c'est lui qui porte `v1.1`, `origin/main` et `miroir/main` ; objets envoyés aux deux remotes) avec `data/modele.bin`, `data/textures.bin` et `assets/maquette.psd` ; `data/modele.bin` est modifié non indexé (même taille, toujours `*`) ; `assets/maquette.psd` est un pointeur seul (objet local supprimé, marqué `-` par `git lfs ls-files -l`, récupérable par `git lfs pull --include=assets/maquette.psd`). Un push vers `origin` fonctionne avec le hook pre-push.

Avec `--conflict`/`--conflict3`, les modifications en cours des sous-modules et de LFS sont faites après le stash : elles restent visibles pendant la fusion.

Le script supprime `<dossier>` et ses dépôts voisins (`-remote.git`, `-miroir.git`, `-lib.git`, `-outils.git`) s'ils existent.

Le script supprime `<dossier>` s'il existe : ne jamais lui passer le dépôt Arbor lui-même ni un dossier de l'utilisateur. Utiliser un chemin temporaire.

Pour un cas non couvert (rebase en cours, HEAD détachée, dépôt vide…), partir de ce dépôt et ajouter les commandes `git` nécessaires plutôt que de modifier le script, sauf si le cas doit devenir standard.
