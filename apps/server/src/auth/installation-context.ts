/** The installation an event API request authenticated as; the installation token middleware resolves it. */
export interface InstallationPrincipal {
  installationId: string;
  workspaceId: string;
  appId: string;
  appVisibility: 'private' | 'public';
  grantedTypes: string[] | null;
}

/** Who may replace an app's catalog: the app key, or an installation token of a private app in its own workspace. */
export interface CatalogPrincipal {
  appId: string;
  ownerWorkspaceId: string;
  via: 'app_key' | 'installation';
  installationId: string | null;
}
