import type { Commit } from '../shared/types';

export interface Edge {
  col: number;
  color: number;
}

/** Ce qu'il faut dessiner dans une ligne du graphe. */
export interface GraphRow {
  col: number; // colonne du nœud
  color: number;
  pass: Edge[]; // lignes verticales qui traversent la ligne
  incoming: Edge[]; // du haut de la ligne vers le nœud
  outgoing: Edge[]; // du nœud vers le bas de la ligne (col = colonne d'arrivée)
  width: number; // nombre de colonnes occupées
}

/** Attribue une colonne à chaque commit (ordre topologique attendu) et calcule les arêtes. */
export function layoutGraph(commits: Commit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const known = new Set(commits.map((c) => c.sha));

  const freeSlot = (avoid: number) => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== avoid) return i;
    return lanes.length === avoid ? avoid + 1 : lanes.length;
  };

  return commits.map((c) => {
    const widthBefore = lanes.length;
    let col = lanes.indexOf(c.sha);
    const isTip = col === -1;
    if (isTip) {
      col = freeSlot(-1);
      lanes[col] = c.sha;
      colors[col] = nextColor++;
    }
    const color = colors[col];

    const incoming: Edge[] = [];
    const pass: Edge[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === c.sha) {
        if (!(isTip && i === col)) incoming.push({ col: i, color: colors[i] });
        if (i !== col) lanes[i] = null;
      } else if (lanes[i] !== null) {
        pass.push({ col: i, color: colors[i] });
      }
    }

    const outgoing: Edge[] = [];
    const parents = c.parents.filter((p) => known.has(p));
    lanes[col] = null;
    parents.forEach((p, idx) => {
      // Le premier parent reste dans la colonne du commit : les lignes ne se rejoignent qu'au parent.
      const existing = idx === 0 ? -1 : lanes.indexOf(p);
      if (existing !== -1) {
        outgoing.push({ col: existing, color: colors[existing] });
        return;
      }
      let target: number;
      if (idx === 0) {
        target = col;
      } else {
        target = freeSlot(col);
        colors[target] = nextColor++;
      }
      lanes[target] = p;
      outgoing.push({ col: target, color: colors[target] });
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(widthBefore, lanes.length, col + 1);
    return { col, color, pass, incoming, outgoing, width };
  });
}
