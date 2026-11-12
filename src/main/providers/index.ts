// Hébergeurs (GitHub, GitLab) : interface commune et registre. Les appels HTTP vivent ici, jamais dans `git.ts`.
// Les adaptateurs (`github.ts`, `gitlab.ts`) et le client HTTP (`http.ts` : `createApiClient`, `fetchImpl`
// injectable, `net.fetch` d'Electron par défaut) s'enregistrent dans `providers`.
import type { AccountInfo, ProviderKind } from '../../shared/types';

/** Client d'API authentifié pour une instance (jeton fourni à la construction, jamais exposé ni journalisé). */
export interface ApiClient {
  request<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, string>; body?: unknown },
  ): Promise<{ data: T; headers: Headers; next: string | null }>;
}

export interface ProviderIdentity {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** null si inconnus (jeton GitHub à permissions fines). */
  scopes: string[] | null;
}

export interface ProviderAdapter {
  kind: ProviderKind;
  /** Base de l'API : https://api.github.com (ou ARBOR_GITHUB_API_URL) ; <instance>/api/v4 pour GitLab. */
  apiBase(instanceUrl: string): string;
  /** Valide un jeton : identité, scopes (null si inconnus). Lève une erreur traduite sinon. */
  validate(client: ApiClient): Promise<ProviderIdentity>;
  /** Identifiant à présenter à Git avec le jeton (login ; « oauth2 » pour un jeton OAuth GitLab). */
  gitUsername(account: AccountInfo, secretKind: 'pat' | 'oauth'): string;
  /** Hôtes SSH par défaut pour cette instance. */
  defaultSshHosts(host: string): string[];
  // Vague 6 (optionnels, ajoutés sans toucher à l'existant) : listPullRequests, getPullRequest, createPullRequest,
  // pullRequestRef.
  // Extension device flow (optionnels) : startDeviceFlow, pollDeviceFlow.
}

/** Registre des adaptateurs : rempli par la fonctionnalité « Comptes ». */
export const providers: Partial<Record<ProviderKind, ProviderAdapter>> = {};
