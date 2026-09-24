import type { SignInProvider } from './accountConfig';

/** A sign-in method that opens the provider's own window. */
export type PopupProvider = Exclude<SignInProvider, 'password'>;

/** What each sign-in method is called when it is shown to people. */
export const PROVIDER_NAME: Record<SignInProvider, string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  microsoft: 'Microsoft',
  password: 'Email and password',
};

/** Firebase's identifier for each method, as in a user's `providerData`. */
export const PROVIDER_ID: Record<SignInProvider, string> = {
  google: 'google.com',
  github: 'github.com',
  apple: 'apple.com',
  microsoft: 'microsoft.com',
  password: 'password',
};

export function isPopupProvider(provider: SignInProvider): provider is PopupProvider {
  return provider !== 'password';
}
