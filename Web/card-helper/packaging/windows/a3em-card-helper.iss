; The Windows installer: per-user, so it needs no administrator rights to install. The helper
; itself asks for elevation (a UAC prompt) only when it writes to a card.
;
;   iscc /DVersion=0.2.0 /DSource=..\..\dist\windows packaging\windows\a3em-card-helper.iss
;
; It registers the helper with each Chromium browser through the helper's own `install`
; command, the same code the macOS and Linux packages run, and removes the registrations
; through `uninstall`.

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0"
#endif
#ifndef Source
  #define Source "..\..\dist\windows"
#endif

[Setup]
AppId={{7C2E0F1A-4B7D-4E0B-9E7B-A3E0C0A3E001}
AppName=A3EM Card Helper
AppVersion={#Version}
AppPublisher=A3EM
AppPublisherURL=https://github.com/vu-a3em/a3em-dashboard
AppSupportURL=https://github.com/vu-a3em/a3em-dashboard/issues
DefaultDirName={localappdata}\Programs\A3EM Card Helper
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible arm64
ArchitecturesInstallIn64BitMode=x64compatible arm64
OutputDir={#Source}\..
OutputBaseFilename=A3EM-Card-Helper-Windows
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=A3EM Card Helper
MinVersion=10.0
; Product name and version on the installer itself, which SignPath requires of anything it signs.
VersionInfoVersion={#NumericVersion}
VersionInfoProductName=A3EM Card Helper
VersionInfoProductVersion={#NumericVersion}
VersionInfoDescription=A3EM Card Helper installer
VersionInfoCopyright=Copyright (c) 2026 vu-a3em. MIT License.

[Files]
Source: "{#Source}\a3em-card-helper-amd64.exe"; DestDir: "{app}"; DestName: "a3em-card-helper.exe"; Check: not IsArm64; Flags: ignoreversion
Source: "{#Source}\a3em-card-helper-arm64.exe"; DestDir: "{app}"; DestName: "a3em-card-helper.exe"; Check: IsArm64; Flags: ignoreversion

[Run]
Filename: "{app}\a3em-card-helper.exe"; Parameters: "install"; Flags: runhidden waituntilterminated; StatusMsg: "Registering with your browsers…"

[UninstallRun]
Filename: "{app}\a3em-card-helper.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "Unregister"

[UninstallDelete]
Type: files; Name: "{app}\org.a3em.card_helper.json"

[Messages]
FinishedLabel=The A3EM Card Helper is installed. Reload the A3EM dashboard; it should show the helper as connected. You also need the A3EM Card Helper browser extension.
