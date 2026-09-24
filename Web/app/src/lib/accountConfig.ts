// Generated from deployment.json by tools/sync-extension-manifest.mjs. Do not edit;
// change deployment.json and run `npm run sync:extension`.

export type SignInProvider = 'google' | 'github' | 'microsoft';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** Null when this deployment offers no accounts. */
export const FIREBASE_CONFIG: FirebaseWebConfig | null = null;

export const SIGN_IN_PROVIDERS: SignInProvider[] = ["google","github"];
