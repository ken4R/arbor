import { useState } from 'react';
import type { RemoteConfig, RepoSnapshot } from '../../shared/types';
import { api } from '../api';
import type { Ui } from '../ui';
import { Dialog } from './Dialog';

// Dialogue d'ajout d'un remote (nom, URL de fetch, URL de push facultative, « Fetch maintenant ») et de modification
// de ses URL (nom fixe). En modification, les champs sont préremplis avec les valeurs brutes de la configuration
// (`api.remoteConfig`), pas avec les URL effectives de l'instantané (réécrites par `insteadOf`) : seul un champ
// réellement modifié est envoyé, et un champ push vidé retire `pushurl`. Le main revalide nom et URL.

type Mode = { kind: 'add'; existing: string[] } | { kind: 'edit'; name: string; config: RemoteConfig };

/** Erreur affichée sous le champ nom (vérification rapide ; `git check-ref-format` tranche côté main). */
function nameError(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (!n) return null; // champ vide : bouton désactivé, sans message
  if (n.startsWith('-')) return 'Le nom ne doit pas commencer par « - ».';
  if (/[\s~^:?*[\\]|\.\.|^\.|\/$|\.lock$|@\{/.test(n)) return 'Nom invalide pour Git (espaces, « .. », « ~ », « ^ », « : », « ? », « * », « [ » et « \\ » sont interdits).';
  if (existing.includes(n)) return `Le remote « ${n} » existe déjà.`;
  return null;
}

/** Erreur affichée sous un champ URL. */
function urlError(url: string): string | null {
  const u = url.trim();
  if (u.startsWith('-')) return 'Une URL ne commence pas par « - ».';
  return null;
}

function RemoteDialog({ ui, repo, mode, onClose }: { ui: Ui; repo: string; mode: Mode; onClose: () => void }) {
  const edit = mode.kind === 'edit' ? mode : null;
  // Plusieurs valeurs pour une clé (URL multiples) : hors périmètre, champ en lecture seule.
  const multiFetch = !!edit && edit.config.urls.length > 1;
  const multiPush = !!edit && edit.config.pushUrls.length > 1;
  const origFetch = edit?.config.urls[0] ?? '';
  const origPush = edit?.config.pushUrls[0] ?? '';

  const [name, setName] = useState('');
  const [fetchUrl, setFetchUrl] = useState(origFetch);
  const [pushUrl, setPushUrl] = useState(origPush);
  const [fetchNow, setFetchNow] = useState(true);

  const fetchChanged = !multiFetch && fetchUrl.trim() !== origFetch;
  const pushChanged = !multiPush && pushUrl.trim() !== origPush;
  const dirty = edit ? fetchChanged || pushChanged : !!(name.trim() || fetchUrl.trim() || pushUrl.trim());

  const nErr = mode.kind === 'add' ? nameError(name, mode.existing) : null;
  const fErr = multiFetch ? null : urlError(fetchUrl);
  const pErr = multiPush ? null : urlError(pushUrl);
  const invalid =
    !!(nErr || fErr || pErr) || (mode.kind === 'add' && !name.trim()) || (!multiFetch && !fetchUrl.trim()) || (!!edit && !fetchChanged && !pushChanged);

  const close = () => {
    if (!dirty) return onClose();
    ui.ask({
      title: 'Abandonner les modifications',
      message: edit ? `Les URL modifiées de « ${edit.name} » ne seront pas enregistrées.` : 'Le remote ne sera pas ajouté.',
      confirm: 'Abandonner',
      danger: true,
      onSubmit: onClose,
    });
  };

  const submit = () => {
    if (invalid) return;
    onClose();
    if (edit) {
      const n = edit.name;
      void ui.run(
        'Modification du remote…',
        async () => {
          if (fetchChanged) await api.setRemoteUrl(repo, n, fetchUrl.trim(), false);
          if (pushChanged) await api.setRemoteUrl(repo, n, pushUrl.trim() || null, true);
        },
        `Remote « ${n} » modifié`,
      );
    } else {
      const n = name.trim();
      void ui.run(fetchNow ? `Ajout et fetch de ${n}…` : 'Ajout du remote…', () => api.addRemote(repo, n, fetchUrl.trim(), pushUrl.trim() || null, fetchNow), `Remote « ${n} » ajouté`);
    }
  };

  return (
    <Dialog
      title={edit ? `Modifier le remote « ${edit.name} »` : 'Ajouter un remote'}
      onClose={close}
      onSubmit={submit}
      submitLabel={edit ? 'Enregistrer' : 'Ajouter'}
      submitDisabled={invalid}
      className="remote-dialog"
      message={edit ? 'Valeurs telles qu’écrites dans la configuration du dépôt (avant réécriture par insteadOf).' : undefined}
    >
      {!edit && (
        <label className="field">
          <span>Nom</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} placeholder="upstream" />
          {nErr && <span className="prefs-hint prefs-hint-error">{nErr}</span>}
        </label>
      )}
      <label className="field">
        <span>URL de fetch</span>
        <input
          autoFocus={!!edit}
          value={multiFetch ? edit!.config.urls.join(' · ') : fetchUrl}
          disabled={multiFetch}
          onChange={(e) => setFetchUrl(e.target.value)}
          spellCheck={false}
          placeholder="https://exemple.org/projet.git"
        />
        {multiFetch && <span className="prefs-hint">Plusieurs URL configurées : modification non prise en charge (utilisez git config).</span>}
        {fErr && <span className="prefs-hint prefs-hint-error">{fErr}</span>}
      </label>
      <label className="field">
        <span>URL de push (facultative)</span>
        <input
          value={multiPush ? edit!.config.pushUrls.join(' · ') : pushUrl}
          disabled={multiPush}
          onChange={(e) => setPushUrl(e.target.value)}
          spellCheck={false}
          placeholder="Identique à l’URL de fetch"
        />
        {multiPush ? (
          <span className="prefs-hint">Plusieurs URL de push configurées : modification non prise en charge (utilisez git config).</span>
        ) : pErr ? (
          <span className="prefs-hint prefs-hint-error">{pErr}</span>
        ) : (
          edit && origPush && !pushUrl.trim() && <span className="prefs-hint">Champ vide : le push reprendra l’URL de fetch.</span>
        )}
      </label>
      {!edit && (
        <label className="check">
          <input type="checkbox" checked={fetchNow} onChange={(e) => setFetchNow(e.target.checked)} />
          Fetch maintenant
        </label>
      )}
    </Dialog>
  );
}

/** Ouvre le dialogue d'ajout d'un remote. */
export function openAddRemoteDialog(ui: Ui, snap: RepoSnapshot) {
  const existing = snap.remotes.map((r) => r.name);
  ui.openDialog((close) => <RemoteDialog ui={ui} repo={snap.path} mode={{ kind: 'add', existing }} onClose={close} />);
}

/** Relit les URL brutes du remote puis ouvre le dialogue de modification. */
export function openEditRemoteDialog(ui: Ui, snap: RepoSnapshot, name: string) {
  const repo = snap.path;
  let config: RemoteConfig | null = null;
  void ui
    .run('Lecture du remote…', async () => {
      config = await api.remoteConfig(repo, name);
    })
    .then((ok) => {
      if (ok && config) {
        const cfg = config;
        ui.openDialog((close) => <RemoteDialog ui={ui} repo={repo} mode={{ kind: 'edit', name, config: cfg }} onClose={close} />);
      }
    });
}
