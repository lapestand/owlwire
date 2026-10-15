import { REGISTRATION_MODES } from '@owlwire/core';
import { z } from 'zod';

/** The signed-in user (nested), the instance admin flag and the id of the user's personal workspace. */
export const MeSchema = z.object({
  user: z.object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
    twoFactorEnabled: z.boolean(),
  }),
  isInstanceAdmin: z.boolean(),
  personalWorkspaceId: z.uuid(),
});

/** What the sign-in page needs before anyone is signed in. Later instance information extends it. */
export const AuthConfigSchema = z.object({
  registration: z.enum(REGISTRATION_MODES),
  socialProviders: z.array(z.enum(['discord', 'google', 'github'])),
  emailEnabled: z.boolean(),
  passkeys: z.boolean(),
});
export const RegistrationSettingSchema = z.object({
  mode: z.enum(REGISTRATION_MODES),
  source: z.enum(['settings', 'config']),
});
export const UpdateRegistrationSettingInput = z.object({ mode: z.enum(REGISTRATION_MODES) });
