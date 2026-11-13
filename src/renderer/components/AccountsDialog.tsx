import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PROVIDERS } from '../../shared/accounts';
import { normalizeInstanceUrl } from '../../shared/remoteUrl';
import type { AccountInfo, AccountStorageStatus, ConnectAccountInput } from '../../shared/types';
import { refreshAccounts, useAccounts, useAccountStorage } from '../accounts';
import { api } from '../api';
import { Dialog } from './Dialog';

// Dialogue « Comptes » : surcouche globale montée dans main.tsx (il s'ouvre aussi depuis l'écran d'accueil, sans
// `UiContext`), ouvert par `openAccounts()` (palette, préférences, accueil, menu d'un remote).
// Jeton : saisi dans un champ masqué, envoyé une seule fois à `connectAccount`, champ vidé dès l'envoi (même en cas
// d'erreur). Il n'est jamais dans les props, dans un état persistant ni dans un journal.

/** Choix du formulaire : GitLab.com et GitLab auto-hébergé sont le même fournisseur, instance différente. */
export type AccountChoice = 'github' | 'gitlab-com' | 'gitlab-self';

export interface AccountsPrefill {
  choice: AccountChoice;
  /** GitLab auto-hébergé : origine (et préfixe) de l'instance. */
  instanceUrl?: string;
}

let state: { open: boolean; prefill: AccountsPrefill | null; seq: number } = { open: false, prefill: null, seq: 0 };
const listeners = new Set<() => void>();

function setState(next: typeof state) {
  state = next;
  listeners.forEach((l) => l());
}

/** Ouvre le dialogue ; `prefill` pré-remplit le formulaire d'ajout (fournisseur deviné d'après un remote). */
export function openAccounts(prefill?: AccountsPrefill): void {
  setState({ open: true, prefill: prefill ?? null, seq: state.seq + 1 });
}

export function closeAccounts(): void {
  if (state.open) setState({ ...state, open: false });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const CHOICES: { value: AccountChoice; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab-com', label: 'GitLab.com' },
  { value: 'gitlab-self', label: 'GitLab auto-hébergé' },
];

const providerOf = (c: AccountChoice) => (c === 'github' ? 'github' : 'gitlab');

/** Choix du formulaire correspondant à un compte existant (pour le reconnecter). */
function choiceOf(a: AccountInfo): AccountsPrefill {
  if (a.provider === 'github') return { choice: 'github' };
  if (a.instanceUrl === PROVIDERS.gitlab.defaultInstance) return { choice: 'gitlab-com' };
  return { choice: 'gitlab-self', instanceUrl: a.instanceUrl };
}

/** Libellé de l'instance d'un compte : « GitLab · git.exemple.org ». */
function instanceLabel(a: AccountInfo): string {
  return `${PROVIDERS[a.provider].label} · ${a.instanceUrl.replace(/^https?:\/\//, '')}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AccountsDialog() {
  const s = useSyncExternalStore(subscribe, () => state);
  return s.open ? <AccountsForm key={s.seq} prefill={s.prefill} /> : null;
}

/** Icône générique de compte (pas de logo de marque). */
function AccountIcon({ status }: { status: 'ok' | 'rejected' }) {
  return (
    <span className={`account-avatar ${status}`} aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        <circle cx="8" cy="5.5" r="2.5" />
        <path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
      </svg>
    </span>
  );
}

function StorageBanner({ storage }: { storage: AccountStorageStatus | null }) {
  if (!storage || storage.encryption === 'available') return null;
  return (
    <div className="accounts-banner" role="note">
      Non mémorisé : aucun trousseau système {storage.encryption === 'weak' ? 'sûr ' : ''}n'est disponible pour chiffrer les jetons. Les comptes connectés sont gardés en
      mémoire et seront oubliés à la fermeture d'Arbor.
    </div>
  );
}

function AccountsForm({ prefill }: { prefill: AccountsPrefill | null }) {
  const accounts = useAccounts();
  const storage = useAccountStorage();
  const [choice, setChoice] = useState<AccountChoice>(prefill?.choice ?? 'github');
  const [instance, setInstance] = useState(prefill?.instanceUrl ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Compte dont la déconnexion attend sa confirmation (deux temps, dans le dialogue). */
  const [confirming, setConfirming] = useState<string | null>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshAccounts();
  }, []);

  const self = choice === 'gitlab-self';
  const inst = self ? normalizeInstanceUrl(instance) : null;
  const instanceError = self && instance.trim() && inst && 'error' in inst ? inst.error : null;
  const instanceUrl = !self ? PROVIDERS[providerOf(choice)].defaultInstance : inst && !('error' in inst) ? inst.url : null;
  // Lien « Créer un jeton » : https seulement (le main refuse toute autre adresse).
  const tokenUrl = instanceUrl && instanceUrl.startsWith('https://') ? PROVIDERS[providerOf(choice)].tokenUrl(instanceUrl) : null;
  const canSubmit = !busy && !!token.trim() && !!instanceUrl;

  const connect = async () => {
    if (!canSubmit || !instanceUrl) return;
    // Le jeton quitte l'état dès l'envoi, réussite ou échec.
    const input: ConnectAccountInput = { provider: providerOf(choice), ...(self ? { instanceUrl } : {}), auth: { method: 'pat', token: token.trim() } };
    setToken('');
    setError(null);
    setNotice(null);
    setBusy('connect');
    try {
      const a = await api.connectAccount(input);
      setNotice(`Compte « ${a.login} » connecté (${instanceLabel(a)}).`);
    } catch (e) {
      setError(errorText(e));
      tokenRef.current?.focus();
    } finally {
      setBusy(null);
    }
  };

  const revalidate = async (a: AccountInfo) => {
    setError(null);
    setNotice(null);
    setBusy(a.id);
    try {
      const r = await api.refreshAccount(a.id);
      setNotice(r.missingScopes.length ? `Compte « ${r.login} » revalidé, mais des scopes manquent.` : `Compte « ${r.login} » revalidé.`);
    } catch (e) {
      setError(errorText(e));
      void refreshAccounts();
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (a: AccountInfo) => {
    setError(null);
    setNotice(null);
    setBusy(a.id);
    try {
      await api.removeAccount(a.id);
      setNotice(`Compte « ${a.login} » déconnecté : son jeton est oublié par Arbor (révoquez-le aussi chez l'hébergeur si besoin).`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setConfirming(null);
      setBusy(null);
    }
  };

  const reconnect = (a: AccountInfo) => {
    const p = choiceOf(a);
    setChoice(p.choice);
    setInstance(p.instanceUrl ?? '');
    setToken('');
    setError(null);
    setNotice(`Saisissez un nouveau jeton pour « ${a.login} ».`);
    tokenRef.current?.focus();
  };

  const openTokenPage = () => {
    if (!tokenUrl) return;
    api.openExternal(tokenUrl).catch((e: unknown) => setError(errorText(e)));
  };

  const provider = PROVIDERS[providerOf(choice)];

  return (
    <Dialog
      title="Comptes"
      className="accounts-dialog"
      onClose={closeAccounts}
      onSubmit={() => void connect()}
      submitLabel={busy === 'connect' ? 'Connexion…' : 'Connecter'}
      submitDisabled={!canSubmit}
      cancelLabel="Fermer"
    >
      <StorageBanner storage={storage} />

      {error && (
        <div className="accounts-error" role="alert">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="accounts-notice" role="status">
          {notice}
        </div>
      )}

      <section className="accounts-section">
        <h3>Comptes connectés</h3>
        {accounts.length === 0 && <div className="accounts-empty">Aucun compte connecté.</div>}
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            busy={busy !== null}
            confirming={confirming === a.id}
            onRevalidate={() => void revalidate(a)}
            onReconnect={() => reconnect(a)}
            onAskDisconnect={() => setConfirming(a.id)}
            onCancelDisconnect={() => setConfirming(null)}
            onDisconnect={() => void disconnect(a)}
          />
        ))}
      </section>

      <section className="accounts-section">
        <h3>Ajouter un compte</h3>
        <div className="seg accounts-seg" role="radiogroup" aria-label="Fournisseur">
          {CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={choice === c.value}
              className={choice === c.value ? 'on' : ''}
              onClick={() => {
                setChoice(c.value);
                setError(null);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        {self && (
          <label className="field">
            URL de l'instance
            <input
              className={instanceError ? 'invalid' : ''}
              value={instance}
              placeholder="https://git.exemple.org"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!instanceError}
              onChange={(e) => setInstance(e.target.value)}
            />
            {instanceError && <span className="prefs-hint prefs-hint-error">{instanceError}</span>}
          </label>
        )}
        <label className="field">
          Jeton d'accès personnel
          <input
            ref={tokenRef}
            className="accounts-token"
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            autoFocus={!!prefill}
            placeholder={choice === 'github' ? 'ghp_… ou github_pat_…' : 'glpat-…'}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <div className="accounts-help">
          <span>{provider.scopeHelp}</span>
          <button
            type="button"
            className="link-btn"
            disabled={!tokenUrl}
            title={tokenUrl ? 'Ouvre la page de création de jeton dans le navigateur' : "Saisissez d'abord une URL d'instance https://"}
            onClick={openTokenPage}
          >
            Créer un jeton…
          </button>
        </div>
      </section>
    </Dialog>
  );
}

function scopeLine(a: AccountInfo): string {
  if (a.scopes === null) {
    return a.provider === 'github'
      ? 'Scopes inconnus (jeton à permissions fines) : vérifiez les accès « Contents » et « Pull requests ».'
      : 'Scopes inconnus (instance ancienne).';
  }
  return a.scopes.length ? `Scopes : ${a.scopes.join(', ')}` : 'Aucun scope';
}

function AccountRow(props: {
  account: AccountInfo;
  busy: boolean;
  confirming: boolean;
  onRevalidate: () => void;
  onReconnect: () => void;
  onAskDisconnect: () => void;
  onCancelDisconnect: () => void;
  onDisconnect: () => void;
}) {
  const a = props.account;
  const n = a.missingScopes.length;
  const noMergeRequests = a.provider === 'gitlab' && a.scopes !== null && n === 0 && !a.scopes.includes('api');
  return (
    <div className={`account-row ${a.status}`}>
      <AccountIcon status={a.status} />
      <div className="account-main">
        <div className="account-instance">{instanceLabel(a)}</div>
        <div className="account-id">
          <span className="account-login">{a.login}</span>
          {a.name && <span className="account-name">{a.name}</span>}
        </div>
        <div className="account-scopes">{scopeLine(a)}</div>
        {n > 0 && (
          <div className="account-warn">
            Scope{n > 1 ? 's' : ''} manquant{n > 1 ? 's' : ''} : {a.missingScopes.join(', ')}. Créez un jeton avec ce{n > 1 ? 's' : ''} scope{n > 1 ? 's' : ''} et reconnectez le compte.
          </div>
        )}
        {noMergeRequests && <div className="account-note">Sans le scope « api », les merge requests ne seront pas disponibles.</div>}
        {a.secretUnreadable ? (
          <div className="account-bad">Jeton illisible (trousseau du système indisponible ou réinitialisé) : reconnectez le compte.</div>
        ) : (
          a.status === 'rejected' && <div className="account-bad">Jeton refusé (expiré ou révoqué) : reconnectez le compte.</div>
        )}
        {!a.persisted && !a.secretUnreadable && <div className="account-note">Non mémorisé (aucun trousseau système) : oublié à la fermeture d'Arbor.</div>}
      </div>
      <div className="account-actions">
        {props.confirming ? (
          <>
            <button type="button" className="btn btn-sm btn-danger" autoFocus disabled={props.busy} onClick={props.onDisconnect}>
              Confirmer la déconnexion
            </button>
            <button type="button" className="btn btn-sm" disabled={props.busy} onClick={props.onCancelDisconnect}>
              Annuler
            </button>
          </>
        ) : (
          <>
            {a.status === 'rejected' && (
              <button type="button" className="btn btn-sm" disabled={props.busy} onClick={props.onReconnect}>
                Reconnecter
              </button>
            )}
            {!a.secretUnreadable && (
              <button type="button" className="btn btn-sm" disabled={props.busy} onClick={props.onRevalidate}>
                Revalider
              </button>
            )}
            <button type="button" className="btn btn-sm" disabled={props.busy} onClick={props.onAskDisconnect}>
              Déconnecter
            </button>
          </>
        )}
      </div>
    </div>
  );
}
