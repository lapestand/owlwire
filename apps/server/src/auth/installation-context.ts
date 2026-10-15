/** The installation an event API request authenticated as; the installation token middleware resolves it. */
export interface InstallationContext {
  id: string;
  appId: string;
  workspaceId: string;
  grantedTypes: string[] | null;
}
