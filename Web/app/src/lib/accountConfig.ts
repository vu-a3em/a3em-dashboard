// Generated from deployment.json by tools/sync-extension-manifest.mjs. Do not edit;
// change deployment.json and run `npm run sync:extension`.

export type SignInProvider = 'google' | 'github' | 'apple' | 'microsoft' | 'password';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** Null when this deployment offers no accounts. */
export const FIREBASE_CONFIG: FirebaseWebConfig | null = {
  "apiKey": "AIzaSyAq4RMjDBN7TF-TZ8rpV3a1xynmGrZSB3A",
  "authDomain": "a3em-679d7.firebaseapp.com",
  "projectId": "a3em-679d7",
  "appId": "1:48538828681:web:d6b06ca33a79073a96eb58"
};

export const SIGN_IN_PROVIDERS: SignInProvider[] = ["google","github","apple","password"];
