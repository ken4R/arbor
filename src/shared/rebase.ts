// Rebase interactif : fonctions pures partagées entre le processus principal (construction de la liste d'instructions
// de `git rebase -i`, lecture de la progression) et le rendu (validation, regroupements, messages par défaut).

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export const REBASE_ACTIONS: readonly RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

/** Version minimale de Git (`--reapply-cherry-picks`, moteur « merge » par défaut). */
export const REBASE_MIN_GIT: readonly [number, number] = [2, 27];

/** Analyse la sortie de `git version` (« git version 2.43.0 », « git version 2.39.3 (Apple Git-146) ») ; null si illisible. */
export function parseGitVersion(out: string): [number, number] | null {
  const m = out.match(/git version (\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const gitVersionAtLeast = (v: readonly [number, number], min: readonly [number, number]) => v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]);

/** Une étape du rebase, dans l'ordre de Git : plus ancien d'abord. */
export interface RebaseStep {
  sha: string;
  action: RebaseAction;
  /** Message final : seulement pour l'étape qui porte le message de son groupe (voir `rebaseGroups`). */
  message?: string;
  /** Sujet d'origine, recopié dans la liste d'instructions pour la lisibilité (ignoré par Git). Rempli par le main. */
  subject?: string;
}

export interface RebaseProgress {
  /** Rebase interactif (`rebase -i`) ; faux pour un rebase simple. */
  interactive: boolean;
  /** Étapes traitées, l'étape d'arrêt comprise. */
  step: number;
  total: number;
  /** Branche réécrite (sans `refs/heads/`), null en HEAD détachée. */
  headName: string | null;
  onto: string;
  /** Commit sur lequel le rebase s'est arrêté. */
  stopped: { sha: string; subject: string } | null;
  reason: 'conflict' | 'edit' | 'exec' | 'other';
  remaining: { action: string; sha: string; subject: string }[];
}

/**
 * Groupe : un commit gardé (pick, reword, edit) suivi des commits fusionnés avec lui (squash, fixup).
 * Indices dans le tableau d'étapes ; les commits supprimés (drop) n'appartiennent à aucun groupe.
 * `owner` : étape qui porte le message final s'il doit être saisi (reword ou squash), sinon null.
 */
export interface RebaseGroup {
  leader: number;
  members: number[];
  owner: number | null;
}

/** Découpe les étapes en groupes ; un squash/fixup sans commit gardé avant lui est ignoré (voir `validateSteps`). */
export function rebaseGroups(steps: readonly RebaseStep[]): RebaseGroup[] {
  const groups: RebaseGroup[] = [];
  steps.forEach((s, i) => {
    if (s.action === 'drop') return;
    if (s.action === 'squash' || s.action === 'fixup') {
      groups[groups.length - 1]?.members.push(i);
      return;
    }
    groups.push({ leader: i, members: [], owner: null });
  });
  for (const g of groups) {
    const last = g.members.length ? g.members[g.members.length - 1] : g.leader;
    if (g.members.some((m) => steps[m].action === 'squash')) g.owner = last;
    else if (steps[g.leader].action === 'reword') g.owner = g.leader;
  }
  return groups;
}

/** Message initial d'un groupe : celui du commit gardé, suivi de ceux des commits « squash » (pas des « fixup »). */
export function defaultGroupMessage(steps: readonly RebaseStep[], group: RebaseGroup, messageOf: (sha: string) => string): string {
  const parts = [group.leader, ...group.members.filter((m) => steps[m].action === 'squash')].map((i) => messageOf(steps[i].sha).trim());
  return parts.filter(Boolean).join('\n\n');
}

/** Nombre de commits après le rebase. */
export function resultCount(steps: readonly RebaseStep[]): number {
  return rebaseGroups(steps).length;
}

/** Erreur bloquante (en français) ou null si les étapes peuvent être lancées. */
export function validateSteps(steps: readonly RebaseStep[]): string | null {
  if (!steps.length) return 'Aucun commit à réécrire.';
  const seen = new Set<string>();
  for (const s of steps) {
    if (!/^[0-9a-f]{40,64}$/.test(s.sha)) return `Identifiant de commit invalide : « ${s.sha} ».`;
    if (seen.has(s.sha)) return `Le commit ${s.sha.slice(0, 7)} apparaît deux fois.`;
    seen.add(s.sha);
    if (!REBASE_ACTIONS.includes(s.action)) return `Action inconnue : « ${s.action} ».`;
  }
  const first = steps.find((s) => s.action !== 'drop');
  if (first && (first.action === 'squash' || first.action === 'fixup'))
    return `Le commit ${first.sha.slice(0, 7)} ne peut pas être fusionné : aucun commit gardé en dessous de lui.`;
  for (const g of rebaseGroups(steps)) {
    if (g.owner === null) continue;
    const s = steps[g.owner];
    if (!s.message?.trim()) return `Le message du commit ${s.sha.slice(0, 7)} est vide.`;
  }
  return null;
}

/** Ligne `exec` qui applique le message n° `n` (fichier `<gitDir>/arbor-rebase/msg-<n>`) au dernier commit. */
export function messageExec(n: number): string {
  return `exec git commit --amend --allow-empty --cleanup=whitespace -q -F "$(git rev-parse --git-path arbor-rebase/msg-${n})"`;
}

/** Une ligne `exec` écrite par Arbor (application d'un message), à exclure du décompte des étapes. */
export const isArborExec = (line: { action: string; rest: string }) => line.action === 'exec' && /arbor-rebase\/msg-\d+/.test(line.rest);

const oneLine = (s: string | undefined) => (s ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * Liste d'instructions de `git rebase -i` (SHA complets) et messages à écrire dans `msg-<n>`.
 * reword → `pick` + exec du message ; groupe avec squash → `fixup` pour chaque commit fusionné puis exec du message final.
 * Les étapes doivent avoir été validées (`validateSteps`).
 */
export function buildTodo(steps: readonly RebaseStep[]): { todo: string; messages: string[] } {
  const lines: string[] = [];
  const messages: string[] = [];
  const groups = rebaseGroups(steps);
  const groupEnd = new Map<number, RebaseGroup>();
  for (const g of groups) groupEnd.set(g.members.length ? g.members[g.members.length - 1] : g.leader, g);
  steps.forEach((s, i) => {
    const line = (action: string) => lines.push(`${action} ${s.sha}${oneLine(s.subject) ? ` ${oneLine(s.subject)}` : ''}`);
    if (s.action === 'drop') line('drop');
    else if (s.action === 'squash' || s.action === 'fixup') line('fixup');
    else line(s.action === 'edit' ? 'edit' : 'pick');
    const g = groupEnd.get(i);
    if (g && g.owner !== null) {
      lines.push(messageExec(messages.length));
      messages.push(`${(steps[g.owner].message ?? '').trim()}\n`);
    }
  });
  return { todo: `${lines.join('\n')}\n`, messages };
}

const ABBREVIATIONS: Record<string, string> = {
  p: 'pick',
  r: 'reword',
  e: 'edit',
  s: 'squash',
  f: 'fixup',
  x: 'exec',
  b: 'break',
  d: 'drop',
  l: 'label',
  t: 'reset',
  m: 'merge',
  u: 'update-ref',
};

/** Commandes dont le premier argument est un commit. */
const WITH_COMMIT = new Set(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);

/**
 * Lit une liste d'instructions (`git-rebase-todo`, `done`) : commentaires et lignes vides ignorés, abréviations
 * développées, CRLF accepté. `sha` est vide pour les commandes sans commit (exec, break, label…).
 */
export function parseTodoLines(text: string): { action: string; sha: string; rest: string }[] {
  const out: { action: string; sha: string; rest: string }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    const action = ABBREVIATIONS[m[1]] ?? m[1];
    let rest = m[2];
    if (!WITH_COMMIT.has(action)) {
      out.push({ action, sha: '', rest });
      continue;
    }
    // `fixup -C <commit>` / `fixup -c <commit>` : l'option précède le commit.
    if (action === 'fixup') rest = rest.replace(/^-[cC]\s+/, '');
    const a = rest.match(/^(\S+)\s*(.*)$/);
    out.push({ action, sha: a?.[1] ?? '', rest: a?.[2] ?? '' });
  }
  return out;
}

/**
 * Progression d'un rebase à partir de `rebase-merge/` : `done` (étapes traitées), `git-rebase-todo` (restantes),
 * présence de `amend` (arrêt « edit »), `stopped-sha`. Les lignes exec d'Arbor ne comptent pas comme des étapes.
 */
export function progressFromFiles(
  f: { done: string; todo: string; amend: boolean; stoppedSha: string | null },
  conflicted: number,
): Omit<RebaseProgress, 'headName' | 'onto' | 'interactive'> {
  const doneAll = parseTodoLines(f.done);
  const done = doneAll.filter((l) => !isArborExec(l));
  const remaining = parseTodoLines(f.todo)
    .filter((l) => !isArborExec(l))
    .map((l) => ({ action: l.action, sha: l.sha, subject: l.rest }));
  const lastAll = doneAll[doneAll.length - 1];
  const lastCommit = [...done].reverse().find((l) => l.sha);
  let reason: RebaseProgress['reason'] = 'other';
  if (conflicted > 0) reason = 'conflict';
  else if (f.amend) reason = 'edit';
  else if (lastAll?.action === 'exec') reason = 'exec';
  else if (f.stoppedSha) reason = 'conflict';
  const stoppedSha = f.stoppedSha ?? lastCommit?.sha ?? null;
  const line = stoppedSha ? [...done].reverse().find((l) => l.sha && (stoppedSha.startsWith(l.sha) || l.sha.startsWith(stoppedSha))) : undefined;
  return {
    step: done.length,
    total: done.length + remaining.length,
    stopped: stoppedSha ? { sha: stoppedSha, subject: line?.rest ?? '' } : null,
    reason,
    remaining,
  };
}
