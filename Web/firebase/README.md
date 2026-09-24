# Accounts

Optional sign-in for the dashboard, so a person's protocol library follows them to any computer.
The site stays on GitHub Pages; sign-in and storage are [Firebase](https://firebase.google.com)
on its free Spark plan, which needs no payment method and cannot bill: past its daily limits,
requests fail until the next day.

| | |
| --- | --- |
| Sign-in | Firebase Authentication, in a popup: Google and GitHub (`accounts.signInProviders` in [`deployment.json`](../deployment.json)) |
| Storage | Cloud Firestore, one record per protocol at `users/<uid>/protocols/<id>` |
| Server side | [`firestore.rules`](firestore.rules), and nothing else: each person can read and write only their own folder |
| App code | [`app/src/lib/firebase.ts`](../app/src/lib/firebase.ts), loaded only when accounts are configured; [`useAccount.ts`](../app/src/lib/useAccount.ts); the sync in [`useProtocols.ts`](../app/src/lib/useProtocols.ts) |
| Record format | [`packages/config-schema/src/protocol-sync.ts`](../packages/config-schema/src/protocol-sync.ts), whose limits the rules repeat |

How it behaves:

- **Signed out**, nothing changes: protocols live in the browser's local storage.
- **Signing in** adds the browser's protocols to the account (a newer save wins; nothing is
  overwritten by an older one) and, once the server has confirmed them, removes them from the
  browser, so each protocol lives in one place.
- **Signed in**, the library is the account's, kept live across computers. A copy stays in the
  browser so it can be read offline, and changes made offline are sent when the connection returns.
- **Signing out** clears that copy, so a shared lab computer does not keep someone's protocols.
- **Deleting the account** deletes its protocols and the sign-in, after asking the person to sign
  in once more.

Free-plan limits, against a research group's use: 1 GiB stored, 50,000 reads and 20,000 writes a
day, no limit on users. A protocol is a few kilobytes.

## Setting it up

Done once, in about 15 minutes, by whoever will own the project. Use a lab or shared Google
account if there is one, and add a second owner at the end, so the project does not depend on one
person.

1. **Create the project.** At <https://console.firebase.google.com>, *Create a new Firebase
   project*, named for example `a3em-dashboard`. Google Analytics is not needed. Stay on the
   Spark plan: never upgrade to Blaze, and decline any offer to upgrade to *Firebase
   Authentication with Identity Platform* (on Spark it adds a limit of 3,000 users a day).
2. **Register the web app.** *Project Overview*, then the web icon (`</>`). Nickname `dashboard`.
   Do not tick Firebase Hosting. Copy the `firebaseConfig` object it shows.
3. **Turn on Google sign-in.** *Build → Authentication → Get started → Sign-in method → Google →
   Enable*, choose the support email, *Save*.
4. **Turn on GitHub sign-in.** In the same list, *GitHub → Enable*, and copy the callback URL it
   shows (`https://<project>.firebaseapp.com/__/auth/handler`). In GitHub, under the `vu-a3em`
   organization's *Settings → Developer settings → OAuth Apps → New OAuth app*: name
   `A3EM Dashboard`, homepage `https://config.a3em.com`, callback URL the one just copied.
   *Register application*, then *Generate a new client secret*. Paste the client ID and secret
   back into Firebase and *Save*. GitHub client secrets do not expire.
5. **Allow the site's address.** *Authentication → Settings → Authorized domains → Add domain*:
   `config.a3em.com`. (`localhost` is already there, for development.)
6. **Create the database.** *Build → Firestore Database → Create database*. Standard edition;
   location near the people using it (`nam5 (United States)` is fine, and cannot be changed later);
   *Start in production mode*.
7. **Check the Google sign-in screen is published.** At <https://console.cloud.google.com>, with
   this project selected: *Google Auth Platform → Audience*. If the publishing status is *Testing*,
   choose *Publish app* (only the basic sign-in scopes are used, so no review is needed). Under
   *Branding*, set the app name and support email. Leave the logo empty: a logo sends the app
   into Google's verification review. Until the branding is verified, Google's sign-in screen names
   the project's `firebaseapp.com` address rather than the app.
8. **Give the dashboard the configuration.** In [`deployment.json`](../deployment.json), replace
   `"firebase": null` with the object from step 2 (quote the keys, as JSON requires). Then, in
   `Web/`:

   ```sh
   npm run sync:extension     # writes it into the app
   npm run firebase -- login  # once per computer
   npm run deploy:rules       # publishes firestore.rules to the project
   npm run ci
   ```

   Commit and push. The Pages workflow deploys the site with sign-in. If GitHub refuses the push
   because it found a "Google API key", that is the Firebase web key, which is public by design
   (the rules are what protect the data): follow the link in the message and allow it.
9. **Add a second owner.** *Project settings → Users and permissions → Add member*, role Owner.

To try it: on <https://config.a3em.com>, *Account → Sign in…* at the bottom of the menu, save a
protocol, and find it in the Firebase console under *Firestore Database → Data → users*.

## Keeping it running

- **Rules** change only with the record format. `npm run test:rules` checks them against the
  emulator (it needs Java 21 or later; the [Account database rules](../../.github/workflows/accounts.yml)
  workflow runs it on every change), and `npm run deploy:rules` publishes them.
- **Google deletes an unused sign-in client after six months** with no sign-ins, emailing the
  owners 30 days first. Any sign-in resets the clock; a deleted client can be restored for 30 days.
- **Adding Microsoft sign-in** (for university accounts) needs an app registered in Microsoft
  Entra, whose client secret expires within two years and must then be renewed. Add `microsoft`
  to `accounts.signInProviders`, run `npm run sync:extension`, and enable it in *Sign-in method*.
- **Storing files** (audio, say) would need Cloud Storage, which since October 2024 requires the
  Blaze plan and a payment method. Everything else can stay in Firestore on Spark.
- **Local development against the emulators**, with no project at all:
  `npm --workspace @a3em/firebase run emulators`, and in another terminal
  `VITE_FIREBASE_EMULATOR=1 npm run dev`. Signing in there needs no popup: it signs in as a test
  user, `test@example.com`.

## What an account stores

Its email address and name, from Google or GitHub, and the protocols its owner saves. Nothing
about cards, recordings, or deployments. The sign-in dialog says the same.
