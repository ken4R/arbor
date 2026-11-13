import { useEffect, useState } from 'react';
import type { CredentialAnswer, CredentialRequest } from '../../shared/types';
import { api, onCredentialDone, onCredentialRequest } from '../api';
import { getCommands, runCommand } from '../commands';
import { Dialog } from './Dialog';

// Dialogue d'identifiants : surcouche globale montée dans main.tsx (il s'ouvre aussi par-dessus l'écran d'accueil,
// pendant un clonage). File d'attente des demandes `credentialRequest`, une à la fois, retirée à chaque
// `credentialDone` (réponse, annulation, fin de la commande Git). Aucun secret ne transite du main vers ici ; ce
// que l'utilisateur saisit n'est envoyé qu'à `answerCredential`, et les champs sont vidés aussitôt.

/** Commande « Comptes… » (fonctionnalité Comptes), si elle est disponible. */
const accountsCommand = () => getCommands().find((c) => c.id === 'accounts.open') ?? null;

export function CredentialDialog() {
  const [queue, setQueue] = useState<CredentialRequest[]>([]);

  useEffect(() => {
    const offRequest = onCredentialRequest((req) => setQueue((q) => (q.some((r) => r.id === req.id) ? q : [...q, req])));
    const offDone = onCredentialDone(({ id }) => setQueue((q) => q.filter((r) => r.id !== id)));
    return () => {
      offRequest();
      offDone();
    };
  }, []);

  const current = queue[0];
  if (!current) return null;
  const reply = (answer: CredentialAnswer | null) => {
    setQueue((q) => q.filter((r) => r.id !== current.id));
    void api.answerCredential(current.id, answer).catch(() => {});
  };
  // `key` : un formulaire neuf (champs vides) pour chaque demande.
  return <CredentialForm key={current.id} req={current} reply={reply} />;
}

function CredentialForm({ req, reply }: { req: CredentialRequest; reply: (a: CredentialAnswer | null) => void }) {
  const [username, setUsername] = useState(req.username ?? '');
  const [secret, setSecret] = useState('');
  const [remember, setRemember] = useState(false);
  const cancel = () => {
    setSecret('');
    reply(null);
  };

  if (req.kind === 'ssh-hostkey') {
    const accept = (ok: boolean) => reply({ kind: 'confirm', accept: ok });
    return (
      <Dialog
        title={`${req.operation} : serveur SSH inconnu`}
        className="credential-dialog"
        onClose={cancel}
        actions={
          <>
            <button type="button" className="btn" autoFocus onClick={() => accept(false)}>
              Refuser
            </button>
            <button type="button" className="btn btn-primary" onClick={() => accept(true)}>
              Faire confiance et continuer
            </button>
          </>
        }
      >
        <p className="dialog-msg">
          Première connexion à <code className="credential-host">{req.host}</code>. Vérifiez que l'empreinte {req.keyType} ci-dessous est bien celle publiée par
          l'hébergeur avant de continuer.
        </p>
        <pre className="credential-fingerprint">{req.fingerprint}</pre>
        <p className="credential-note">En cas de doute, refusez : Arbor ne se connectera pas et rien ne sera enregistré.</p>
      </Dialog>
    );
  }

  if (req.kind === 'https') {
    const origin = req.protocol && req.host ? `${req.protocol}://${req.host}` : req.host ?? 'le serveur';
    const accounts = accountsCommand();
    const submit = () => {
      const answer: CredentialAnswer = { kind: 'https', username, password: secret, rememberForSession: remember };
      setSecret('');
      reply(answer);
    };
    return (
      <Dialog
        title={`${req.operation} : identifiants requis`}
        className="credential-dialog"
        message={
          <>
            <code className="credential-host">{origin}</code> demande un identifiant et un mot de passe (ou un jeton d'accès personnel).
          </>
        }
        onClose={cancel}
        onSubmit={submit}
        submitLabel="Se connecter"
        submitDisabled={!username.trim()}
      >
        <label className="field">
          <span>Identifiant</span>
          <input autoFocus={!username} value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>
        <label className="field">
          <span>Mot de passe ou jeton</span>
          <input className="secret-field" type="password" autoFocus={!!username} value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Mémoriser pendant cette session
        </label>
        {req.userHelpers.length > 0 && (
          <p className="credential-note">
            Votre gestionnaire d'identifiants Git ({req.userHelpers.join(', ')}) les enregistrera si la connexion réussit.
          </p>
        )}
        {accounts && (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              cancel();
              runCommand(accounts.id);
            }}
          >
            Connecter plutôt un compte…
          </button>
        )}
      </Dialog>
    );
  }

  // Phrase de passe, mot de passe SSH, autre invite : un champ masqué.
  const title = req.kind === 'ssh-passphrase' ? 'phrase de passe SSH' : req.kind === 'ssh-password' ? 'mot de passe SSH' : 'saisie requise';
  const submit = () => {
    const value = secret;
    setSecret('');
    reply({ kind: 'secret', value });
  };
  return (
    <Dialog title={`${req.operation} : ${title}`} className="credential-dialog" onClose={cancel} onSubmit={submit} submitLabel="Valider">
      {req.kind === 'ssh-passphrase' ? (
        <p className="dialog-msg">
          Phrase de passe de la clé <code className="credential-host">{req.keyPath}</code>.
        </p>
      ) : req.kind === 'ssh-password' ? (
        <p className="dialog-msg">
          Mot de passe pour <code className="credential-host">{req.username ? `${req.username}@${req.host}` : req.host}</code>.
        </p>
      ) : (
        <pre className="credential-prompt">{req.prompt.trim()}</pre>
      )}
      <label className="field">
        <span>{req.kind === 'ssh-passphrase' ? 'Phrase de passe' : req.kind === 'ssh-password' ? 'Mot de passe' : 'Réponse'}</span>
        <input className="secret-field" type="password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      {req.kind === 'ssh-passphrase' && (
        <p className="credential-note">Pour ne plus la saisir, chargez la clé dans votre agent SSH (ssh-add) : Arbor l'utilise automatiquement.</p>
      )}
    </Dialog>
  );
}

