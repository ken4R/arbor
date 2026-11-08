import type { RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import { useUi } from '../ui';

const STATE_LABEL = {
  merging: 'Fusion en cours',
  rebasing: 'Rebase en cours',
  'cherry-picking': 'Cherry-pick en cours',
  reverting: 'Revert en cours',
} as const;

/** Texte de confirmation de « Passer » : sur un arrêt edit ou exec, le commit existe déjà et reste tel quel. */
export function skipConfirmMessage(snap: RepoSnapshot): string {
  const rb = snap.status.state === 'rebasing' ? snap.status.rebase ?? null : null;
  if (rb && (rb.reason === 'edit' || rb.reason === 'exec')) return 'Les modifications non commitées seront perdues ; le commit reste tel quel.';
  const what = rb?.stopped ? `Le commit ${rb.stopped.sha.slice(0, 7)}${rb.stopped.subject ? ` « ${rb.stopped.subject} »` : ''}` : 'Le commit en cours';
  return `${what} ne sera pas appliqué : ses modifications, et les résolutions de conflit déjà faites pour lui, seront perdues.`;
}

/** Bandeau de l'opération en cours (fusion, rebase, cherry-pick, revert) : état, progression du rebase, actions. */
export function OperationBanner({ repo, snap }: { repo: string; snap: RepoSnapshot }) {
  const ui = useUi();
  const st = snap.status;
  if (st.state === 'clean') return null;
  const rb = st.state === 'rebasing' ? st.rebase ?? null : null;
  const stopped = rb?.stopped ? (
    <>
      arrêté sur <code>{rb.stopped.sha.slice(0, 7)}</code>
      {rb.stopped.subject && <> « {rb.stopped.subject} »</>}
    </>
  ) : null;

  let text: React.ReactNode = st.conflicted.length ? `${st.conflicted.length} conflit(s) à résoudre` : 'Plus de conflits : vous pouvez continuer.';
  if (rb && !st.conflicted.length && rb.reason === 'edit') text = 'Modifiez puis Continuer ; « Modifier le dernier commit » pour l’amender.';
  else if (rb && !st.conflicted.length && rb.reason === 'exec')
    text = 'Le message n’a pas pu être appliqué (hook ?) : corrigez avec « Modifier le dernier commit » puis Continuer.';
  else if (rb && !st.conflicted.length && rb.reason === 'empty')
    text = 'Ce commit est devenu vide (ses changements sont déjà présents) : Continuer le retire.';
  const canSkip = st.state !== 'merging';

  const skip = () => {
    ui.ask({
      title: 'Passer l’étape en cours',
      message: skipConfirmMessage(snap),
      confirm: 'Passer',
      danger: true,
      onSubmit: () => ui.run('Passage de l’étape…', () => api.skipOp(repo)),
    });
  };

  return (
    <div className="op-banner">
      <strong>
        {STATE_LABEL[st.state]}
        {rb && rb.total > 0 && (
          <span className="op-step">
            {' '}
            · étape {rb.step}/{rb.total}
          </span>
        )}
      </strong>
      {stopped && <span className="op-stopped">{stopped}</span>}
      <span>{text}</span>
      {rb && rb.remaining.length > 0 && (
        <details className="op-remaining">
          <summary>
            {rb.remaining.length} étape{rb.remaining.length > 1 ? 's' : ''} restante{rb.remaining.length > 1 ? 's' : ''}
          </summary>
          <ul>
            {rb.remaining.map((r, i) => (
              <li key={i}>
                <span className="op-remaining-action">{r.action}</span> {r.sha && <code>{r.sha.slice(0, 7)}</code>} {r.subject}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="op-actions">
        <button
          className="btn btn-sm"
          onClick={() =>
            ui.ask({
              title: 'Abandonner l\'opération en cours',
              message: 'Le dépôt revient à son état d\'avant l\'opération. Les conflits déjà résolus seront perdus.',
              confirm: 'Abandonner',
              danger: true,
              onSubmit: () => ui.run('Abandon…', () => api.abort(repo)),
            })
          }
        >
          Abandonner
        </button>
        {canSkip && (
          <button className="btn btn-sm" title="Ne pas appliquer le commit en cours et passer au suivant" onClick={skip}>
            Passer
          </button>
        )}
        <button className="btn btn-sm btn-primary" disabled={st.conflicted.length > 0} onClick={() => ui.run('Continuer…', () => api.continueOp(repo))}>
          Continuer
        </button>
      </div>
    </div>
  );
}
