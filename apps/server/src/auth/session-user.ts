/** The signed-in user as the services see it; the session middleware resolves it from the session cookie. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  isInstanceAdmin: boolean;
  twoFactorEnabled: boolean;
}
