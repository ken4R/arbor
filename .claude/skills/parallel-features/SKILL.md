---
name: parallel-features
description: Développer plusieurs fonctionnalités indépendantes d'Arbor en parallèle avec des agents developer, chacun dans son worktree, puis relire, ouvrir les PR et gérer les conflits.
---

# Fonctionnalités en parallèle

## 1. Planifier

Demande à l'agent `architect` un plan pour l'ensemble des fonctionnalités, avec pour chacune : les fichiers touchés et les fichiers partagés modifiés. Deux fonctionnalités sont **indépendantes** si aucune n'a besoin du code de l'autre et si elles ne modifient pas les mêmes fonctions. Ajouter chacune une méthode à `ArborApi` ou une entrée de menu reste acceptable : ce sont des ajouts.

Ce qui dépend d'une autre fonctionnalité attend la vague suivante.

## 2. Lancer une vague

Pour chaque fonctionnalité indépendante, lance un agent `developer` **en arrière-plan avec `isolation: "worktree"`**, dans le même message pour qu'ils tournent en même temps. Le prompt de chaque agent contient :
- son extrait du plan de l'architect ;
- le nom de branche (`feat/<nom-court>`) ;
- les fichiers qu'il peut modifier ;
- le chemin du dépôt principal (pour lier `node_modules`).

Limite raisonnable : 3 ou 4 agents par vague.

## 3. Intégrer chaque résultat

Quand un agent termine :
1. Lis son compte rendu et le diff (`git diff origin/main...origin/feat/<nom>`).
2. Fais relire le diff par l'agent `reviewer` ; corrige ce qui est réel (sur la branche de l'agent).
3. Ouvre la PR vers `main`.

## 4. Fusions et conflits

- Fusionne les PR une par une. Après chaque fusion, les branches restantes qui touchent les mêmes fichiers partagés fusionnent `main` (merge, pas rebase si quelqu'un d'autre a la branche) ; résous les conflits d'ajouts en gardant les deux côtés, puis relance typecheck + tests.
- Un conflit sur une même logique n'est pas un conflit d'ajouts : il signale que les fonctionnalités n'étaient pas indépendantes. Arrête-toi et demande à l'utilisateur.

## 5. Vague suivante

Mets à jour le plan avec ce qui a été fusionné et lance la vague suivante depuis `main` à jour.
