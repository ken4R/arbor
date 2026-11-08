import { useEffect, useRef, useState } from 'react';
import type { RepoSnapshot, Tag } from '../../shared/types';
import { api } from '../api';
import type { Ui } from '../ui';
import { Dialog } from './Dialog';

// Dialogues des tags : création (léger ou annoté, publication facultative) et suppression (locale, et distante
// si le tag y est présent). Les remotes et tags sont ceux de l'instantané à l'ouverture : le main revérifie tout.

/** Remote proposé par défaut : origin s'il existe, sinon le premier. */
function defaultRemote(snap: RepoSnapshot): string | null {
  return snap.remotes.some((r) => r.name === 'origin') ? 'origin' : (snap.remotes[0]?.name ?? null);
}

/** Choix du remote : rien s'il n'y en a qu'un (son nom est dans le libellé), une liste sinon. */
function RemoteSelect({ remotes, value, onChange, disabled }: { remotes: string[]; value: string; onChange: (r: string) => void; disabled?: boolean }) {
  if (remotes.length < 2) return null;
  return (
    <select className="tag-remote" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label="Remote">
      {remotes.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}

/** Ouvre le dialogue de création d'un tag sur `sha` ; `where` décrit le commit (ex. « HEAD », « 1a2b3c4 « sujet » »). */
export function openTagDialog(ui: Ui, snap: RepoSnapshot, sha: string, where: string) {
  ui.openDialog((close) => <TagDialog ui={ui} snap={snap} sha={sha} where={where} onClose={close} />);
}

function TagDialog({ ui, snap, sha, where, onClose }: { ui: Ui; snap: RepoSnapshot; sha: string; where: string; onClose: () => void }) {
  const remotes = snap.remotes.map((r) => r.name);
  const [name, setName] = useState('');
  const [annotated, setAnnotated] = useState(true);
  const [message, setMessage] = useState('');
  const [push, setPush] = useState(false);
  const [remote, setRemote] = useState(defaultRemote(snap) ?? '');

  const trimmed = name.trim();
  const exists = snap.tags.some((t) => t.name === trimmed);
  const invalid = !trimmed || exists || (annotated && !message.trim());

  const close = () => {
    if (!name && !message) return onClose();
    ui.ask({ title: 'Abandonner le tag', message: 'Le nom et le message saisis seront perdus.', confirm: 'Abandonner', danger: true, onSubmit: onClose });
  };

  const submit = () => {
    if (invalid) return;
    onClose();
    const repo = snap.path;
    const msg = annotated ? message : null;
    const target = push && remote ? remote : null;
    void ui.run(
      target ? 'Création et publication du tag…' : 'Création du tag…',
      async () => {
        await api.createTag(repo, trimmed, sha, msg);
        if (!target) return;
        try {
          await api.pushTag(repo, target, trimmed);
        } catch (e) {
          throw new Error(`Tag créé localement, mais le push a échoué : ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      target ? `Tag « ${trimmed} » créé et poussé vers ${target}` : `Tag « ${trimmed} » créé`,
    );
  };

  return (
    <Dialog title="Nouveau tag" message={`Sur ${where}`} onClose={close} onSubmit={submit} submitLabel="Créer" submitDisabled={invalid} className="tag-dialog">
      <label className="field">
        <span>Nom du tag</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} placeholder="v1.2.0" />
        {exists && <span className="tag-error">Un tag « {trimmed} » existe déjà.</span>}
      </label>
      <label className="check">
        <input type="checkbox" checked={annotated} onChange={(e) => setAnnotated(e.target.checked)} />
        Tag annoté (auteur, date et message)
      </label>
      {annotated && (
        <label className="field">
          <span>Message</span>
          <textarea className="tag-message" value={message} onChange={(e) => setMessage(e.target.value)} rows={4} />
        </label>
      )}
      {remotes.length > 0 && (
        <div className="tag-push">
          <label className="check">
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
            {remotes.length === 1 ? `Pousser vers ${remote}` : 'Pousser vers'}
          </label>
          <RemoteSelect remotes={remotes} value={remote} onChange={setRemote} disabled={!push} />
        </div>
      )}
    </Dialog>
  );
}

/** Pousse un tag vers un remote. */
export function pushTagAction(ui: Ui, repo: string, remote: string, name: string) {
  return ui.run(`Push du tag ${name}…`, () => api.pushTag(repo, remote, name), `Tag « ${name} » poussé vers ${remote}`);
}

/** Pousse tous les tags locaux vers un remote. */
export function pushAllTagsAction(ui: Ui, repo: string, remote: string) {
  return ui.run('Push des tags…', () => api.pushAllTags(repo, remote), `Tags poussés vers ${remote}`);
}

/** Ouvre la confirmation de suppression d'un tag (et éventuellement de sa copie distante). */
export function openDeleteTagDialog(ui: Ui, snap: RepoSnapshot, tag: Tag) {
  ui.openDialog((close) => <DeleteTagDialog ui={ui} snap={snap} tag={tag} onClose={close} />);
}

type RemoteCheck = 'loading' | 'present' | 'absent' | 'error';

function DeleteTagDialog({ ui, snap, tag, onClose }: { ui: Ui; snap: RepoSnapshot; tag: Tag; onClose: () => void }) {
  const remotes = snap.remotes.map((r) => r.name);
  const [remote, setRemote] = useState(defaultRemote(snap) ?? '');
  const [check, setCheck] = useState<RemoteCheck>('loading');
  const [alsoRemote, setAlsoRemote] = useState(false);
  // La case a été changée par l'utilisateur pour ce remote : le résultat de ls-remote ne l'écrase pas.
  const touched = useRef(false);

  const changeRemote = (r: string) => {
    touched.current = false;
    setAlsoRemote(false);
    setRemote(r);
  };

  // Présence du tag sur le remote choisi : la case est pré-cochée s'il y est (sauf choix de l'utilisateur).
  useEffect(() => {
    if (!remote) return;
    let live = true;
    setCheck('loading');
    api.remoteTags(snap.path, remote).then(
      (list) => {
        if (!live) return;
        const present = list.some((t) => t.name === tag.name);
        setCheck(present ? 'present' : 'absent');
        if (!touched.current) setAlsoRemote(present);
      },
      () => live && setCheck('error'),
    );
    return () => {
      live = false;
    };
  }, [remote, snap.path, tag.name]);

  const submit = () => {
    onClose();
    const repo = snap.path;
    const target = alsoRemote && remote ? remote : null;
    // Le distant d'abord : s'il échoue, le tag local reste et l'opération peut être refaite.
    void ui.run(
      'Suppression du tag…',
      async () => {
        if (target) await api.deleteRemoteTag(repo, target, tag.name);
        await api.deleteTag(repo, tag.name);
      },
      target ? `Tag « ${tag.name} » supprimé (local et ${target})` : `Tag « ${tag.name} » supprimé`,
    );
  };

  const note = { loading: 'vérification…', present: 'présent', absent: 'absent', error: 'injoignable' }[check];

  return (
    <Dialog
      title="Supprimer le tag"
      message={`Le tag « ${tag.name} » sera supprimé de ce dépôt.${alsoRemote && remote ? ` Il sera aussi supprimé sur ${remote}, pour tous ceux qui le récupèrent.` : ''}`}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Supprimer"
      danger
      className="tag-dialog"
    >
      {remotes.length > 0 && (
        <div className="tag-push">
          <label className="check">
            <input
              type="checkbox"
              checked={alsoRemote}
              onChange={(e) => {
                touched.current = true;
                setAlsoRemote(e.target.checked);
              }}
            />
            {remotes.length === 1 ? `Supprimer aussi sur ${remote}` : 'Supprimer aussi sur'}
          </label>
          <RemoteSelect remotes={remotes} value={remote} onChange={changeRemote} />
          <span className={`tag-remote-note tag-remote-${check}`}>({note})</span>
        </div>
      )}
    </Dialog>
  );
}
