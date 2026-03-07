#define MyAppName "__APP_NAME__"
#define MyAppVersion "__APP_VERSION__"
#define MyAppDirName "__APP_DIR_NAME__"
#define MySourceRoot "__SOURCE_ROOT__"
#define MyOutputRoot "__OUTPUT_ROOT__"
#define MyOutputBaseName "__OUTPUT_BASENAME__"

[Setup]
AppId={{A68E32B0-4AA6-4B16-9364-B668731F7062}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=OpenAI
DefaultDirName={autopf}\{#MyAppDirName}
DefaultGroupName={#MyAppDirName}
OutputDir={#MyOutputRoot}
OutputBaseFilename={#MyOutputBaseName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\_internal\app\Codex.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest

[Files]
Source: "{#MySourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Launch Codex Offline"; Filename: "{app}\Launch Codex Offline.vbs"; IconFilename: "{app}\_internal\app\Codex.exe"
Name: "{autodesktop}\Launch Codex Offline"; Filename: "{app}\Launch Codex Offline.vbs"; IconFilename: "{app}\_internal\app\Codex.exe"
Name: "{group}\Sync Codex Skills"; Filename: "{app}\Sync Codex Skills.vbs"; IconFilename: "{app}\_internal\app\Codex.exe"

[Run]
Filename: "{app}\Launch Codex Offline.vbs"; Description: "Launch Codex Offline"; Flags: nowait postinstall skipifsilent shellexec
