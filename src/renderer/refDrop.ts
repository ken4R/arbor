import type { Branch, RepoSnapshot } from '../shared/types';
import { api } from './api';
import type { MenuItem } from './components/ContextMenu';
import { openRebaseDialog } from './components/RebaseDialog';
import type { Ui } from './ui';

// Glisser-déposer de branches : une branche (badge du graphe, élément de la barre latérale) déposée sur une branche,
// un commit ou un remote ouvre un menu d'actions, jamais une action directe. `dropActions` (pur, testé) décide des
// actions proposées ; il est partagé avec `RefActionDialog`, l'alternative au clavier. Aucun `git` pendant le
// glisser : le processus principal revérifie tout au moment d'agir.

/** Type de données du glisser HTML5 (les fichiers et le texte venus d'ailleurs sont ignorés). */
export const REF_MIME = 'application/x-arbor-ref';

/** Branche glissée : locale, ou distante (`remote` vrai, nom complet `origin/x`). */
export interface DragRef {
  name: string;
  remote: boolean;
}

export type DropTarget = { kind: 'branch'; name: string; remote: boolean } | { kind: 'commit'; sha: string } | { kind: 'remote'; name: string };

export type RefActionId = 'merge' | 'fastForward' | 'checkoutMerge' | 'rebase' | 'rebaseInteractive' | 'checkoutRebaseInteractive' | 'move' | 'push';

/** Action proposée pour une source et une cible ; `disabledReason` dit pourquoi elle est grisée. */
export interface RefAction {
  id: RefActionId;
  label: string;
  disabledReason?: string;
  danger?: boolean;
  source: DragRef;
  target: DropTarget;
}

const q = (s: string) => `« ${s} »`;

const STATE_LABEL: Record<string, string> = {
  merging: 'fusion',
  rebasing: 'rebase',
  'cherry-picking': 'cherry-pick',
  reverting: 'revert',
};

/** Pourquoi rien ne peut être glissé dans ce dépôt (dépôt vide), ou null. */
export function dragDisabledReason(snap: RepoSnapshot): string | null {
  return snap.commits.length === 0 ? 'Dépôt vide : aucune branche à glisser.' : null;
}

function findBranch(snap: RepoSnapshot, name: string, remote: boolean): Branch | undefined {
  return snap.branches.find((b) => b.remote === remote && b.name === name);
}

/** Groupe d'affichage d'une action (séparateur entre groupes dans le menu). */
const GROUP: Record<RefActionId, number> = {
  merge: 0,
  fastForward: 0,
  checkoutMerge: 0,
  rebase: 1,
  rebaseInteractive: 1,
  checkoutRebaseInteractive: 1,
  move: 2,
  push: 3,
};

/**
 * Actions possibles quand `src` est déposée sur `tgt` (liste vide = dépôt refusé). Calculées sur l'instantané seul :
 * branche courante ou non, HEAD détachée, opération en cours (tout est grisé avec la raison), même commit.
 */
export function dropActions(snap: RepoSnapshot, src: DragRef, tgt: DropTarget): RefAction[] {
  if (dragDisabledReason(snap)) return [];
  const srcBranch = findBranch(snap, src.name, src.remote);
  if (!srcBranch || (src.remote && src.name.endsWith('/HEAD'))) return [];
  const current = snap.status.branch;
  const srcCurrent = !src.remote && src.name === current;
  const S = q(src.name);
  const out: RefAction[] = [];
  const add = (id: RefActionId, label: string, extra: Partial<RefAction> = {}) => out.push({ id, label, source: src, target: tgt, ...extra });

  if (tgt.kind === 'branch') {
    // Une branche distante n'est jamais une cible (le push passe par le remote).
    if (tgt.remote || (!src.remote && src.name === tgt.name)) return [];
    const tb = findBranch(snap, tgt.name, false);
    if (!tb) return [];
    const C = q(tgt.name);
    const same = tb.sha === srcBranch.sha ? `${S} et ${C} pointent sur le même commit.` : undefined;
    if (tgt.name === current) {
      add('merge', `Fusionner ${S} dans ${C}`, { disabledReason: same });
    } else {
      add('fastForward', `Avancer ${C} jusqu'à ${S} (fast-forward, sans checkout)`, { disabledReason: same });
      add('checkoutMerge', `Basculer sur ${C} puis fusionner ${S} (vous restez sur ${C})`, { disabledReason: same });
    }
    // Seule une branche locale se rebase.
    if (!src.remote) {
      if (srcCurrent) {
        add('rebase', `Rebaser ${S} sur ${C}…`, { disabledReason: same });
        add('rebaseInteractive', `Rebase interactif de ${S} sur ${C}…`, { disabledReason: same });
      } else {
        add('rebase', `Rebaser ${S} sur ${C} (vous serez sur ${S} à la fin)…`, { disabledReason: same });
        add('checkoutRebaseInteractive', `Basculer sur ${S} puis rebase interactif sur ${C}…`, { disabledReason: same });
      }
    }
  } else if (tgt.kind === 'commit') {
    if (src.remote) return [];
    const short = tgt.sha.slice(0, 7);
    const onIt = srcBranch.sha === tgt.sha ? `${S} pointe déjà sur ce commit.` : undefined;
    add('rebase', srcCurrent ? `Rebaser ${S} sur ${short}…` : `Rebaser ${S} sur ${short} (vous serez sur ${S} à la fin)…`, { disabledReason: onIt });
    add('move', `Déplacer ${S} ici…`, {
      danger: true,
      disabledReason: srcCurrent ? 'Branche courante : utilisez un reset depuis le menu du commit.' : onIt,
    });
  } else {
    if (src.remote || !snap.remotes.some((r) => r.name === tgt.name)) return [];
    const remoteSha = findBranch(snap, `${tgt.name}/${src.name}`, true)?.sha;
    add('push', `Pousser ${S} vers ${q(tgt.name)}`, { disabledReason: remoteSha === srcBranch.sha ? `${q(`${tgt.name}/${src.name}`)} est déjà à jour.` : undefined });
  }

  const state = snap.status.state;
  if (state !== 'clean') {
    const reason = `Opération en cours (${STATE_LABEL[state] ?? state}) : terminez-la ou abandonnez-la d'abord.`;
    for (const a of out) a.disabledReason = reason;
  }
  return out;
}

/** Entrées de menu pour des actions (séparateur entre fusion, rebase, déplacement et push). */
export function refActionMenu(ui: Ui, snap: RepoSnapshot, actions: RefAction[]): MenuItem[] {
  const items: MenuItem[] = [];
  actions.forEach((a, i) => {
    if (i > 0 && GROUP[a.id] !== GROUP[actions[i - 1].id]) items.push('separator');
    items.push({ label: a.label, danger: a.danger, disabled: !!a.disabledReason, hint: a.disabledReason, onClick: () => runRefAction(ui, snap, a) });
  });
  return items;
}

/** SHA de la branche locale d'après l'instantané, ou erreur (la branche a disparu entre-temps). */
function localSha(snap: RepoSnapshot, name: string): string {
  const b = findBranch(snap, name, false);
  if (!b) throw new Error(`La branche « ${name} » n'existe plus : rafraîchissez.`);
  return b.sha;
}

/** Exécute une action (confirmation d'abord pour le rebase, le déplacement et la publication d'une branche). */
export function runRefAction(ui: Ui, snap: RepoSnapshot, a: RefAction): void {
  if (a.disabledReason) return;
  const repo = snap.path;
  const src = a.source.name;
  const tgt = a.target;
  switch (a.id) {
    case 'merge':
      void ui.run('Fusion…', () => api.merge(repo, src), 'Fusion terminée');
      return;
    case 'fastForward': {
      if (tgt.kind !== 'branch') return;
      void ui.run('Avance rapide…', async () => api.fastForwardBranch(repo, tgt.name, localSha(snap, tgt.name), src), `${q(tgt.name)} avancée jusqu'à ${q(src)}`);
      return;
    }
    case 'checkoutMerge': {
      if (tgt.kind !== 'branch') return;
      void ui.run(
        `Checkout de ${tgt.name} puis fusion…`,
        async () => {
          await api.checkout(repo, tgt.name);
          await api.merge(repo, src);
        },
        'Fusion terminée',
      );
      return;
    }
    case 'rebase': {
      const onto = tgt.kind === 'branch' ? tgt.name : tgt.kind === 'commit' ? tgt.sha : null;
      if (!onto) return;
      const ontoLabel = tgt.kind === 'branch' ? q(tgt.name) : onto.slice(0, 7);
      const current = snap.status.branch === src;
      ui.ask({
        title: `Rebaser ${q(src)} sur ${ontoLabel}`,
        message:
          `Les commits de ${q(src)} absents de ${ontoLabel} seront rejoués par-dessus.` +
          (current ? '' : ` ${q(src)} sera extraite et le restera à la fin.`) +
          ' Les modifications non commitées bloquent le rebase, sauf si vous les mettez de côté.',
        confirm: 'Rebaser',
        checkbox: { label: 'Mettre de côté et réappliquer (autostash)', initial: false },
        onSubmit: (_v, autostash) => void ui.run('Rebase…', () => api.rebaseBranch(repo, src, onto, autostash), 'Rebase terminé'),
      });
      return;
    }
    case 'rebaseInteractive':
      if (tgt.kind === 'branch') openRebaseDialog(ui, snap, tgt.name, q(tgt.name));
      return;
    case 'checkoutRebaseInteractive': {
      if (tgt.kind !== 'branch') return;
      // Le planificateur ne travaille que sur HEAD : checkout d'abord, puis le dialogue (qui relit le dépôt).
      void ui.run(`Checkout de ${src}…`, () => api.checkout(repo, src)).then((ok) => ok && openRebaseDialog(ui, snap, tgt.name, q(tgt.name)));
      return;
    }
    case 'move': {
      if (tgt.kind !== 'commit') return;
      const old = findBranch(snap, src, false)?.sha;
      if (!old) return;
      ui.ask({
        title: `Déplacer ${q(src)}`,
        message:
          `${q(src)} pointera sur ${tgt.sha.slice(0, 7)} au lieu de ${old.slice(0, 7)}, sans checkout ni fusion. ` +
          `Les commits qui ne seront plus atteignables par aucune branche restent récupérables par le reflog de ${q(src)}.`,
        confirm: 'Déplacer',
        danger: true,
        onSubmit: () => void ui.run('Déplacement de la branche…', () => api.moveBranch(repo, src, old, tgt.sha), `${q(src)} déplacée`),
      });
      return;
    }
    case 'push': {
      if (tgt.kind !== 'remote') return;
      const run = (setUpstream: boolean) =>
        void ui.run(`Push de ${src} vers ${tgt.name}…`, () => api.pushBranch(repo, tgt.name, src, setUpstream), `${q(src)} poussée vers ${q(tgt.name)}`);
      if (findBranch(snap, src, false)?.upstream) return run(false);
      ui.ask({
        title: `Pousser ${q(src)} vers ${q(tgt.name)}`,
        message: `${q(src)} n'a pas de branche distante : elle sera publiée sous ${q(`${tgt.name}/${src}`)}.`,
        confirm: 'Pousser',
        checkbox: { label: `Suivre ${q(`${tgt.name}/${src}`)} (-u)`, initial: true },
        onSubmit: (_v, setUpstream) => run(setUpstream),
      });
      return;
    }
  }
}

// État du glisser en cours. `dataTransfer` n'est pas lisible pendant `dragover` : la source est gardée ici, remise à
// zéro sur `drop`/`dragend` (aussi au niveau de window, voir `main.tsx` : un badge virtualisé peut être démonté).

let dragged: DragRef | null = null;
let hover: { el: HTMLElement; allowed: boolean } | null = null;

/** Glisser d'une branche d'Arbor (et non d'un fichier ou d'un texte venu d'ailleurs). */
export function isRefDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!dragged && !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(REF_MIME);
}

/** Début du glisser d'une branche (à appeler dans `onDragStart` de la source). */
export function startRefDrag(e: React.DragEvent, ref: DragRef) {
  e.stopPropagation();
  dragged = ref;
  e.dataTransfer.setData(REF_MIME, JSON.stringify(ref));
  e.dataTransfer.setData('text/plain', ref.name);
  e.dataTransfer.effectAllowed = 'move';
  document.body.classList.add('ref-dragging');
}

/** Fin du glisser (dépôt, annulation, sortie de la fenêtre). */
export function endRefDrag() {
  dragged = null;
  setHover(null, false, false);
  document.body.classList.remove('ref-dragging');
}

/** Retire le surlignage de la cible survolée (le pointeur a quitté toute cible). */
export function clearDropHover() {
  setHover(null, false, false);
}

function setHover(el: HTMLElement | null, allowed: boolean, ok: boolean) {
  if (hover?.el !== el) hover?.el.classList.remove('drop-ok', 'drop-no');
  hover = el ? { el, allowed } : null;
  if (el) {
    el.classList.toggle('drop-ok', ok);
    el.classList.toggle('drop-no', !ok);
  }
}

/**
 * Gestionnaires d'une cible de dépôt. Les actions ne sont recalculées (et la classe `.drop-ok`/`.drop-no` posée)
 * qu'au changement de cible ; un dépôt accepté ouvre le menu des actions au point de dépôt.
 */
export function dropTargetProps(ui: Ui, snap: RepoSnapshot, target: DropTarget) {
  return {
    onDragOver(e: React.DragEvent) {
      if (!isRefDrag(e)) return;
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      let allowed = hover && hover.el === el ? hover.allowed : null;
      if (allowed === null) {
        const actions = dropActions(snap, dragged!, target);
        allowed = actions.length > 0;
        setHover(el, allowed, actions.some((a) => !a.disabledReason));
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = allowed ? 'move' : 'none';
    },
    onDrop(e: React.DragEvent) {
      if (!isRefDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const src = dragged!;
      endRefDrag();
      const actions = dropActions(snap, src, target);
      if (actions.length) ui.openMenu(e, refActionMenu(ui, snap, actions));
    },
  };
}

/** Défilement automatique d'une liste quand le pointeur d'un glisser approche de ses bords. */
export function autoScrollOnDrag(el: HTMLElement, clientY: number, step: number) {
  const r = el.getBoundingClientRect();
  const edge = Math.min(48, r.height / 4);
  if (clientY < r.top + edge) el.scrollTop -= step;
  else if (clientY > r.bottom - edge) el.scrollTop += step;
}
