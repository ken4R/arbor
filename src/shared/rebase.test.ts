import { describe, expect, it } from 'vitest';
import { REBASE_MIN_GIT, buildTodo, defaultGroupMessage, gitVersionAtLeast, messageExec, parseGitVersion, parseTodoLines, progressFromFiles, rebaseGroups, todoWithoutOrphanedGroup, resultCount, validateSteps, type RebaseStep } from './rebase';

const sha = (c: string) => c.repeat(40);
const A = sha('a');
const B = sha('b');
const C = sha('c');
const D = sha('d');

describe('buildTodo', () => {
  it('garde l\'ordre donné (réordonnancement) avec des SHA complets', () => {
    const { todo, messages } = buildTodo([
      { sha: C, action: 'pick' },
      { sha: A, action: 'pick' },
      { sha: B, action: 'edit' },
    ]);
    expect(todo).toBe(`pick ${C}\npick ${A}\nedit ${B}\n`);
    expect(messages).toEqual([]);
  });

  it('recopie le sujet sur une seule ligne', () => {
    expect(buildTodo([{ sha: A, action: 'pick', subject: 'Un\r\nsujet' }]).todo).toBe(`pick ${A} Un sujet\n`);
  });

  it('reword : pick puis exec du message', () => {
    const { todo, messages } = buildTodo([
      { sha: A, action: 'reword', message: '  Nouveau titre\n\nCorps  ' },
      { sha: B, action: 'pick' },
    ]);
    expect(todo).toBe(`pick ${A}\n${messageExec(0)}\npick ${B}\n`);
    expect(messages).toEqual(['Nouveau titre\n\nCorps\n']);
  });

  it('reword sur le premier commit d\'un groupe de fixup : message appliqué après le groupe', () => {
    const { todo, messages } = buildTodo([
      { sha: A, action: 'reword', message: 'Titre' },
      { sha: B, action: 'fixup' },
    ]);
    expect(todo).toBe(`pick ${A}\nfixup ${B}\n${messageExec(0)}\n`);
    expect(messages).toEqual(['Titre\n']);
  });

  it('groupe squash : fixup pour chaque commit fusionné puis un seul exec avec le message final', () => {
    const steps: RebaseStep[] = [
      { sha: A, action: 'pick' },
      { sha: B, action: 'squash' },
      { sha: C, action: 'fixup', message: 'Final' },
      { sha: D, action: 'reword', message: 'Autre' },
    ];
    const { todo, messages } = buildTodo(steps);
    expect(todo).toBe(`pick ${A}\nfixup ${B}\nfixup ${C}\n${messageExec(0)}\npick ${D}\n${messageExec(1)}\n`);
    expect(messages).toEqual(['Final\n', 'Autre\n']);
  });

  it('groupe sans squash (fixup seuls) : aucun message', () => {
    expect(buildTodo([{ sha: A, action: 'pick' }, { sha: B, action: 'fixup' }])).toEqual({ todo: `pick ${A}\nfixup ${B}\n`, messages: [] });
  });

  it('un commit supprimé entre deux membres ne coupe pas le groupe', () => {
    const steps: RebaseStep[] = [
      { sha: A, action: 'pick' },
      { sha: B, action: 'drop' },
      { sha: C, action: 'squash', message: 'AC' },
    ];
    expect(buildTodo(steps).todo).toBe(`pick ${A}\ndrop ${B}\nfixup ${C}\n${messageExec(0)}\n`);
  });

  it('tout supprimer', () => {
    expect(buildTodo([{ sha: A, action: 'drop' }, { sha: B, action: 'drop' }])).toEqual({ todo: `drop ${A}\ndrop ${B}\n`, messages: [] });
  });

  it('un message avec « # » est conservé tel quel (nettoyage whitespace)', () => {
    const { messages } = buildTodo([{ sha: A, action: 'reword', message: 'Titre\n\n# pas un commentaire\n#42' }]);
    expect(messages).toEqual(['Titre\n\n# pas un commentaire\n#42\n']);
    expect(messageExec(0)).toContain('--cleanup=whitespace');
  });
});

describe('rebaseGroups et messages', () => {
  it('le dernier commit d\'un groupe squash porte le message', () => {
    const steps: RebaseStep[] = [
      { sha: A, action: 'reword' },
      { sha: B, action: 'squash' },
      { sha: C, action: 'pick' },
    ];
    expect(rebaseGroups(steps)).toEqual([
      { leader: 0, members: [1], owner: 1 },
      { leader: 2, members: [], owner: null },
    ]);
    expect(resultCount(steps)).toBe(2);
  });

  it('message par défaut : commit gardé puis les squash, sans les fixup', () => {
    const steps: RebaseStep[] = [
      { sha: A, action: 'pick' },
      { sha: B, action: 'fixup' },
      { sha: C, action: 'squash' },
    ];
    const msg: Record<string, string> = { [A]: 'Titre A\n\nCorps A', [B]: 'fixup! Titre A', [C]: 'Titre C\n' };
    expect(defaultGroupMessage(steps, rebaseGroups(steps)[0], (s) => msg[s])).toBe('Titre A\n\nCorps A\n\nTitre C');
  });
});

describe('validateSteps', () => {
  it('accepte une liste valide', () => {
    expect(validateSteps([{ sha: A, action: 'pick' }, { sha: B, action: 'squash', message: 'x' }])).toBeNull();
    expect(validateSteps([{ sha: A, action: 'drop' }])).toBeNull();
  });

  it('refuse une liste vide, un doublon, un SHA abrégé, une action inconnue', () => {
    expect(validateSteps([])).toMatch(/Aucun commit/);
    expect(validateSteps([{ sha: A, action: 'pick' }, { sha: A, action: 'pick' }])).toMatch(/deux fois/);
    expect(validateSteps([{ sha: 'abc1234', action: 'pick' }])).toMatch(/invalide/);
    expect(validateSteps([{ sha: A, action: 'exec' as never }])).toMatch(/inconnue/);
  });

  it('refuse un squash ou fixup sans commit gardé en dessous (y compris après des drop)', () => {
    expect(validateSteps([{ sha: A, action: 'fixup' }])).toMatch(/ne peut pas être fusionné/);
    expect(validateSteps([{ sha: A, action: 'drop' }, { sha: B, action: 'squash', message: 'x' }])).toMatch(/ne peut pas être fusionné/);
  });

  it('refuse un message vide pour un reword ou un groupe squash', () => {
    expect(validateSteps([{ sha: A, action: 'reword', message: '  \n' }])).toMatch(/vide/);
    expect(validateSteps([{ sha: A, action: 'pick' }, { sha: B, action: 'squash' }])).toMatch(/bbbbbbb.*vide/);
  });
});

describe('parseTodoLines', () => {
  it('développe les abréviations, ignore commentaires et lignes vides, accepte CRLF', () => {
    const text = `p ${A} Un\r\n# commentaire\r\n\r\nf -C ${B} Deux\r\ns ${C}\r\nx make test\r\nd ${D} Quatre\r\nbreak\r\n`;
    expect(parseTodoLines(text)).toEqual([
      { action: 'pick', sha: A, rest: 'Un' },
      { action: 'fixup', sha: B, rest: 'Deux' },
      { action: 'squash', sha: C, rest: '' },
      { action: 'exec', sha: '', rest: 'make test' },
      { action: 'drop', sha: D, rest: 'Quatre' },
      { action: 'break', sha: '', rest: '' },
    ]);
  });

  it('relit ce que produit buildTodo', () => {
    const { todo } = buildTodo([{ sha: A, action: 'reword', message: 'x', subject: 'Sujet' }]);
    expect(parseTodoLines(todo)).toEqual([
      { action: 'pick', sha: A, rest: 'Sujet' },
      { action: 'exec', sha: '', rest: messageExec(0).slice(5) },
    ]);
  });
});

describe('todoWithoutOrphanedGroup', () => {
  it('reword sauté : retire la ligne exec qui appliquerait son message au commit précédent', () => {
    const todo = `${messageExec(0)}\npick ${B} Deux\n`;
    expect(todoWithoutOrphanedGroup(`pick ${A} Un\n`, todo, false)).toBe(`pick ${B} Deux\n`);
  });

  it('chef d\'un groupe squash sauté : retire les fixup du groupe et son exec, garde la suite', () => {
    const todo = `fixup ${B} Deux\r\nfixup ${C} Trois\r\n${messageExec(1)}\r\npick ${D} Quatre\r\n${messageExec(2)}\r\n`;
    expect(todoWithoutOrphanedGroup(`pick ${sha('e')}\n${messageExec(0)}\nedit ${A} Un\n`, todo, false)).toBe(`pick ${D} Quatre\r\n${messageExec(2)}\r\n`);
  });

  it('groupe de fixup seuls (sans exec) : retire les fixup', () => {
    expect(todoWithoutOrphanedGroup(`pick ${A}\n`, `# commentaire\nfixup ${B}\npick ${C}\n`, false)).toBe(`# commentaire\npick ${C}\n`);
  });

  it('ne retire rien : arrêt edit (commit déjà créé), membre d\'un groupe, exec en échec, rien qui suit', () => {
    const todo = `fixup ${B}\n${messageExec(0)}\n`;
    expect(todoWithoutOrphanedGroup(`edit ${A}\n`, todo, true)).toBeNull();
    expect(todoWithoutOrphanedGroup(`pick ${A}\nfixup ${C}\n`, todo, false)).toBeNull();
    expect(todoWithoutOrphanedGroup(`pick ${A}\n${messageExec(0)}\n`, `pick ${B}\n`, false)).toBeNull();
    expect(todoWithoutOrphanedGroup(`pick ${A}\n`, `pick ${B}\n${messageExec(0)}\n`, false)).toBeNull();
    expect(todoWithoutOrphanedGroup('', todo, false)).toBeNull();
  });
});

describe('parseGitVersion', () => {
  it('lit la version, y compris les suffixes de distribution', () => {
    expect(parseGitVersion('git version 2.43.0\n')).toEqual([2, 43]);
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toEqual([2, 39]);
    expect(parseGitVersion('git version 2.45.1.windows.1')).toEqual([2, 45]);
    expect(parseGitVersion('inconnu')).toBeNull();
  });

  it('compare au minimum requis', () => {
    expect(gitVersionAtLeast([2, 27], REBASE_MIN_GIT)).toBe(true);
    expect(gitVersionAtLeast([3, 0], REBASE_MIN_GIT)).toBe(true);
    expect(gitVersionAtLeast([2, 26], REBASE_MIN_GIT)).toBe(false);
    expect(gitVersionAtLeast([1, 99], REBASE_MIN_GIT)).toBe(false);
  });
});

describe('progressFromFiles', () => {
  it('exclut les exec d\'Arbor du décompte et des étapes restantes', () => {
    const p = progressFromFiles(
      { done: `pick ${A} Un\n${messageExec(0)}\nedit ${B} Deux\n`, todo: `${messageExec(1)}\npick ${C} Trois\nexec make\n`, amend: true, stoppedSha: B },
      0,
    );
    expect(p).toEqual({
      step: 2,
      total: 4,
      stopped: { sha: B, subject: 'Deux' },
      reason: 'edit',
      remaining: [
        { action: 'pick', sha: C, subject: 'Trois' },
        { action: 'exec', sha: '', subject: 'make' },
      ],
    });
  });

  it('conflit : raison « conflict », même une fois les conflits résolus (stopped-sha)', () => {
    const files = { done: `pick ${A} Un\npick ${B} Deux\n`, todo: `pick ${C} Trois\n`, amend: false, stoppedSha: B };
    expect(progressFromFiles(files, 2).reason).toBe('conflict');
    expect(progressFromFiles(files, 0).reason).toBe('conflict');
    expect(progressFromFiles(files, 0).stopped).toEqual({ sha: B, subject: 'Deux' });
  });

  it('exec en échec (hook) : arrêt sur le dernier commit traité', () => {
    const p = progressFromFiles({ done: `pick ${A} Un\n${messageExec(0)}\n`, todo: `pick ${B} Deux\n`, amend: false, stoppedSha: null }, 0);
    expect(p.reason).toBe('exec');
    expect(p.stopped).toEqual({ sha: A, subject: 'Un' });
    expect([p.step, p.total]).toEqual([1, 2]);
  });

  it('commit devenu vide : arrêt sans conflit, index propre', () => {
    const files = { done: `pick ${A} Un\n`, todo: '', amend: false, stoppedSha: A, clean: true };
    expect(progressFromFiles(files, 0).reason).toBe('empty');
    expect(progressFromFiles({ ...files, clean: false }, 0).reason).toBe('conflict');
  });

  it('affiche les actions choisies dans le planificateur à la place de pick/fixup', () => {
    const p = progressFromFiles(
      { done: `edit ${A} Un\n`, todo: `pick ${B} Deux\n${messageExec(0)}\nfixup ${C} Trois\npick ${D} Quatre\n`, amend: true, stoppedSha: A, actions: { [B]: 'reword', [C]: 'squash' } },
      0,
    );
    expect(p.remaining.map((r) => r.action)).toEqual(['reword', 'squash', 'pick']);
  });

  it('fichiers vides : aucune étape', () => {
    expect(progressFromFiles({ done: '', todo: '', amend: false, stoppedSha: null }, 0)).toEqual({ step: 0, total: 0, stopped: null, reason: 'other', remaining: [] });
  });
});
