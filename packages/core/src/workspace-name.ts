/**
 * Longest workspace name, in Unicode code points. The API validation and the server-made names (personal workspaces)
 * share this limit and measure it the same way, so a name the server made always passes the API's check when a
 * client sends it back.
 */
export const WORKSPACE_NAME_MAX = 80;

/** Length of a workspace name as WORKSPACE_NAME_MAX measures it: code points, not UTF-16 units. */
export function workspaceNameLength(name: string): number {
  return Array.from(name).length;
}

/** The trimmed name cut to WORKSPACE_NAME_MAX code points (a surrogate pair is never split). */
export function clampWorkspaceName(name: string): string {
  return Array.from(name.trim()).slice(0, WORKSPACE_NAME_MAX).join('').trim();
}
