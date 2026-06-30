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
UseLongPathAware=yes

[Files]
Source: "{#MySourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: files; Name: "{app}\Codex.exe"
Type: files; Name: "{app}\Codex.lnk"
Type: files; Name: "{app}\Setup Codex.vbs"
Type: files; Name: "{app}\Launch Codex Offline.vbs"
Type: files; Name: "{app}\Launch Codex Offline.cmd"
Type: files; Name: "{app}\Sync Codex Skills.vbs"
Type: files; Name: "{app}\Sync Codex Skills.cmd"
Type: files; Name: "{app}\Repair Chrome Host.vbs"
Type: files; Name: "{app}\Repair Chrome Host.cmd"

[Icons]
Name: "{group}\Codex"; Filename: "{app}\Codex.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\_internal\app\Codex.exe"
Name: "{autodesktop}\Codex"; Filename: "{app}\Codex.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\_internal\app\Codex.exe"
Name: "{group}\Setup Codex"; Filename: "{app}\Setup Codex.cmd"; IconFilename: "{app}\_internal\app\Codex.exe"

[Run]
Filename: "{app}\Setup Codex.cmd"; Description: "Set up Codex Offline"; Flags: nowait postinstall skipifsilent shellexec
