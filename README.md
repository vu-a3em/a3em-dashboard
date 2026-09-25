# A3EM Dashboard

The A3EM Dashboard is the tool for setting up A3EM recorders before a deployment and for
looking at what they recorded afterward. It is a website: open
**[config.a3em.com](https://config.a3em.com)** in your browser, and there is nothing to install
for most of what it does.

Everything happens on your own computer. Recordings, logs and positions on an SD card are read by
your browser and are never uploaded anywhere.

## What you can do with it

- **Configure** a deployment: when the recorder listens, how it records audio and motion, its
  label, dates and time zone. The dashboard checks the settings as you go, estimates how long the
  SD card and the battery will last, and writes the settings file onto the card. Settings you use
  again and again can be saved as a *protocol*.
- **Prepare devices** in a batch: one set of settings, with each unit's own label, written card
  after card. If the settings change after some cards are written, the dashboard marks those
  cards to be prepared again, so every unit in a batch records the same way.
- **Review a card** from a recorder that has come back: whether its self-test passed, whether and
  why it stopped early, battery and temperature over time, the health of its microphone, the hours
  it recorded against the hours it was meant to, and where it went, if it had GPS. A clock that
  was set wrong can be corrected for display without changing the card.
- **Listen** to the recordings, day by day, with each clip's waveform and loudness.
- **Check and copy** a card to your computer. Every recording is checked, and recordings cut
  short because the recorder lost power are repaired in the copy. The card itself is never changed.

It works best in **Google Chrome** or **Microsoft Edge**; Brave, Vivaldi, Arc and Opera also work.
Firefox and Safari cannot open SD cards from a web page, so there you can create settings and
download the file, then copy it onto the card yourself.

**Accounts are optional.** Signing in keeps your saved protocols with you on any computer. Nothing
else is stored, and everything works without an account.

## The A3EM Card Helper (optional)

A web page cannot reach an SD card's hardware, so a few jobs need the **A3EM Card Helper**. It has
two parts: a small program you install on your computer, and a browser extension that lets the
dashboard talk to it. With it, the dashboard can also:

- test that a card really holds what it claims (counterfeit cards are common) and writes quickly
  enough for the recorder;
- erase and format a card with the exact layout the recorders were tested with;
- check a card is ready to deploy, before it goes into a recorder;
- copy a whole card to a file, check its filesystem, repair it, and open a card that no longer
  opens;
- eject a card safely.

To install it, choose **Install…** under *A3EM Card Helper* at the bottom of the dashboard's menu.
It shows the steps for your computer. The program is downloaded from this project's
[releases page](https://github.com/vu-a3em/a3em-dashboard/releases/latest), and the extension
comes from the
[Chrome Web Store](https://chromewebstore.google.com/detail/a3em-card-helper/fccaomdnpebkiakcflkdgidnnodpalik).
Neither part sends anything over the internet. It asks for your password before changing a card,
and shows you exactly which card it is about to erase so you can confirm it.

### How you know the download is genuine

Each release is built from the public code in this repository, on GitHub's own servers, by a
published build script, so anyone can see what went into it.

- **macOS:** the installer is signed with the project's Apple Developer ID and notarized by Apple,
  which checks it for malicious software.
- **Windows:** the installer and the program are signed through
  [SignPath Foundation](https://signpath.org), which provides free code signing to open-source
  projects. Every release is approved by hand before it is signed. The details are in the
  [code signing policy](Web/card-helper/README.md#code-signing-policy).
- **Linux:** the packages are not signed.
- **The browser extension** is reviewed by Google and distributed, signed, by the Chrome Web Store.

## Privacy

The dashboard has no advertising, analytics or tracking. What an account stores, and what the A3EM
Card Helper keeps on your computer, is set out in the
[privacy policy](https://config.a3em.com/privacy.html).

## What is in this repository

| Folder | What it is |
| --- | --- |
| [`Web/`](Web) | The dashboard itself: the website, the A3EM Card Helper program and its browser extension, the optional accounts, and the rules for recorder settings and files that all of them share. [`Web/README.md`](Web/README.md) is the place to start for developers. |
| [`a3em-firmware/`](https://github.com/vu-a3em/a3em-firmware) | The software that runs on the recorders, linked here from its own repository. The dashboard is checked against it, so its settings always match what the recorder actually does. |
| [`Python/`](Python) | The earlier desktop version of the dashboard, which the website replaces. |

## Getting help

To report a problem or ask for a feature, open an issue at
[github.com/vu-a3em/a3em-dashboard/issues](https://github.com/vu-a3em/a3em-dashboard/issues). For
anything else, email [support@a3em.com](mailto:support@a3em.com).

## License

Released under the [MIT License](LICENSE): free to use, copy, change and share, including for
commercial purposes, as long as the copyright notice stays with it. It comes with no warranty.
