# Accounts

Optional sign-in for the dashboard, so a person's protocol library follows them to any computer.
The site stays on GitHub Pages; sign-in and storage are [Firebase](https://firebase.google.com)
on its free Spark plan, which needs no payment method and cannot bill: past its daily limits,
requests fail until the next day.

| | |
| --- | --- |
| Sign-in | Firebase Authentication: Google, GitHub, Apple or Microsoft in a popup, or an email address and password; whichever `accounts.signInProviders` in [`deployment.json`](../deployment.json) lists |
| Storage | Cloud Firestore, one record per protocol at `users/<uid>/protocols/<id>` |
| Server side | [`firestore.rules`](firestore.rules), and nothing else: each person can read and write only their own folder |
| App code | [`app/src/lib/firebase.ts`](../app/src/lib/firebase.ts), sign-in, loaded after the page when accounts are configured (about 37 kB compressed); [`firestore.ts`](../app/src/lib/firestore.ts), the database, loaded only once someone signs in (about 160 kB); [`useAccount.ts`](../app/src/lib/useAccount.ts); the sync in [`useProtocols.ts`](../app/src/lib/useProtocols.ts) |
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
   Do not check Firebase Hosting. Copy the `firebaseConfig` object it shows.
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
   *Branding*, set the app name, the support email, the home page `https://config.a3em.com`, and
   the privacy policy `https://config.a3em.com/privacy.html`. Leave the logo empty: a logo sends
   the app into Google's verification review. Until the branding is verified, Google's sign-in screen names
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

## Adding sign-in methods

The dashboard supports `google`, `github`, `apple`, `microsoft` and `password` (an email address
and password). Each is offered only when it is both listed in `accounts.signInProviders` in
[`deployment.json`](../deployment.json) and enabled in the Firebase console. After changing the
list, run `npm run sync:extension` and `npm run ci` from `Web/`, then commit and push.

### Apple

Needs the Apple Developer Program membership (team `D3TVN67UY9`). In
<https://developer.apple.com/account/resources>, *Certificates, Identifiers & Profiles*:

1. **An App ID** to hang it on. *Identifiers → + → App IDs → App*. Description `A3EM Dashboard`,
   explicit Bundle ID `com.a3em.dashboard`. Under *Capabilities* check *Sign In with Apple*.
   *Continue → Register*.
2. **A Services ID**, which is what the web sign-in uses. *Identifiers → + → Services IDs*.
   Description `A3EM Dashboard` (Apple shows it on its sign-in screen), identifier
   `com.a3em.dashboard.signin`. *Continue → Register*. Open it from the list, check
   *Sign In with Apple*, *Configure*: primary App ID `A3EM Dashboard`; *Domains and Subdomains*
   `a3em-679d7.firebaseapp.com`; *Return URLs*
   `https://a3em-679d7.firebaseapp.com/__/auth/handler`. *Next → Done → Continue → Save*.
3. **A key.** *Keys → +*. Name `A3EM Dashboard sign-in`, check *Sign in with Apple*, *Configure*,
   primary App ID `A3EM Dashboard`, *Save → Continue → Register*. Note the Key ID and *Download*
   the `.p8` file. It can be downloaded only once: keep it with the project's other private
   credentials. It does not expire.
4. **In Firebase**: *Authentication → Sign-in method → Add new provider → Apple → Enable*.
   Services ID `com.a3em.dashboard.signin`. Under *OAuth code flow configuration*: Apple team ID
   `D3TVN67UY9`, the Key ID, and the private key (open the `.p8` in a text editor and paste all of
   it, including the BEGIN and END lines). *Save*.
5. Add `"apple"` to `accounts.signInProviders`.

The key in step 4 is also what lets the dashboard withdraw its access to someone's Apple ID when
they delete their account, as Apple asks. People who choose *Hide My Email* sign in with an Apple
relay address; the dashboard sends Apple users no email, so the relay needs no setting up.

### Email address and password

For people with no Google, GitHub or Apple account to use.

1. *Authentication → Sign-in method → Add new provider → Email/Password → Enable*. Leave
   *Email link (passwordless sign-in)* off: on the free plan it can send only five emails a day.
   *Save*.
2. *Authentication → Templates*: set the sender name to `A3EM Dashboard` in the email
   address verification and password reset templates, and send the emails' links to the
   dashboard (see [Account emails](#account-emails) below).
3. *Authentication → Settings → User account management*: leave *Email enumeration protection*
   on. It stops the sign-in form telling a stranger which addresses have accounts.
4. Add `"password"` to `accounts.signInProviders`.

The dashboard asks for passwords of at least eight characters, sends a confirmation link when an
account is created, offers a reset link from *Forgot the password?*, and asks for the password
again before deleting an account. The free plan sends up to 150 reset and 1,000 confirmation
emails a day.

### Microsoft

For university accounts. Needs an app registered in Microsoft Entra, whose client secret
expires within two years and must then be renewed in Entra and in Firebase. Follow
<https://firebase.google.com/docs/auth/web/microsoft-oauth>, then add `"microsoft"` to
`accounts.signInProviders`.

### One account, several ways in

Firebase keeps one account per email address (*Authentication → Settings → User account linking*:
leave it on *Link accounts that use the same email*). So someone who signed up with Google and
later tries GitHub with the same address is refused; the dashboard then holds the GitHub sign-in,
asks them to sign in the way they did before, and adds GitHub to that account, so either works
from then on. Their account settings list every way in, with *Add* and *Remove*; the last one
cannot be removed.

## Account emails

Confirmation and password-reset emails are sent by Firebase from `noreply@a3em.com`, the custom
domain set up under *Authentication → Templates*.

**Send their links to the dashboard.** In *Authentication → Templates*, edit any template, choose
*Customize action URL*, and enter `https://config.a3em.com/`; it applies to every template.
Firebase then adds `?mode=…&oobCode=…` to that address, and the dashboard completes the step in
its account dialog. Two reasons:

- **Mail scanners.** Microsoft's Safe Links, used by most university and company mail, opens every
  link in an email before delivering it. On Firebase's own page that visit uses the link up, so
  the owner later hears it "has expired or has already been used". The dashboard only reads the
  link until its owner presses *Confirm my email address* or sets a new password.
- **Spam filters.** Links to `*.firebaseapp.com` are common in phishing, so filters distrust them.
  Links to `config.a3em.com` match the sending domain.

Deploy the dashboard before changing the action URL: an older dashboard ignores the links.

**If the console says "An error occurred updating action URL",** Firebase has locked this
project's email settings. The API behind the console gives the real reason,
`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`, even for a change to the action URL alone. Google does not
document when it applies this lock (it is part of its measures against Authentication emails
being used for spam), and only Firebase support can lift it:
<https://firebase.google.com/support/troubleshooter/contact>. Until then the links keep going
to Firebase's own page, and the dashboard copes: its confirmation links carry a continue link
back to the dashboard, and an address confirmed elsewhere is noticed as soon as the dashboard's
tab is used again, without pressing *I have confirmed it*. Email scanners can still use a link up
first; the address is then confirmed anyway, and the dashboard says so.

**Keep the domain's records whole.** The DNS for `a3em.com` needs, and on 24 September 2026 had:

| Record | Name | Value |
| --- | --- | --- |
| MX | `a3em.com` | `mxa.mailgun.org`, `mxb.mailgun.org` (Squarespace's email forwarding) |
| TXT | `a3em.com` | `v=spf1 include:mailgun.org include:_spf.firebasemail.com ~all` (one `v=spf1` record only; merge any others into it) |
| TXT | `a3em.com` | `firebase=a3em-679d7` |
| CNAME | `firebase1._domainkey` | `mail-a3em-com.dkim1._domainkey.firebasemail.com` |
| CNAME | `firebase2._domainkey` | `mail-a3em-com.dkim2._domainkey.firebasemail.com` |
| TXT | `_dmarc` | `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` |

The MX records let the sending domain receive mail, which filters check; the templates send from
and reply to `support@a3em.com`, which Squarespace forwards.

**When a message is still flagged,** open it in the quarantine or junk folder and view its
headers. `Authentication-Results` should read `spf=pass`, `dkim=pass header.d=a3em.com` and
`dmarc=pass`. A DKIM signature for any other domain means the custom domain has not been applied
(*Templates → Apply custom domain*). Marking the message *Not junk* or *Not phishing* teaches the
filter; for a whole organization's mail, its IT administrators can allow `a3em.com`.

## Keeping it running

- **Rules** change only with the record format. `npm run test:rules` checks them against the
  emulator (it needs Java 21 or later; the [Account database rules](../../.github/workflows/accounts.yml)
  workflow runs it on every change), and `npm run deploy:rules` publishes them.
- **Google deletes an unused sign-in client after six months** with no sign-ins, emailing the
  owners 30 days first. Any sign-in resets the clock; a deleted client can be restored for 30 days.
- **Storing files** (audio, say) would need Cloud Storage, which since October 2024 requires the
  Blaze plan and a payment method. Everything else can stay in Firestore on Spark.
- **Local development against the emulators**, with no project at all:
  `npm --workspace @a3em/firebase run emulators`, and in another terminal
  `VITE_FIREBASE_EMULATOR=1 npm run dev`. Signing in there needs no popup: it signs in as a test
  user, `test@example.com`.

## What an account stores

Its email address and name, and the protocols its owner saves. Nothing about cards, recordings,
or deployments. The sign-in dialog says the same, and links to the dashboard's privacy policy,
[`app/public/privacy.html`](../app/public/privacy.html), served at
<https://config.a3em.com/privacy.html>. Change the policy first if what is stored ever changes.
