#define MyAppName "__APP_NAME__"
#define MyAppVersion "__APP_VERSION__"
#define MyAppDirName "__APP_DIR_NAME__"
#define MySourceRoot "__SOURCE_ROOT__"
#define MyInstallerRoot "__INSTALLER_ROOT__"
#define MyOutputRoot "__OUTPUT_ROOT__"
#define MyOutputBaseName "__OUTPUT_BASENAME__"

[Setup]
AppId={{A68E32B0-4AA6-4B16-9364-B668731F7062}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=OpenAI
DefaultDirName={%USERPROFILE|{localappdata}}\Codex
DefaultGroupName={#MyAppDirName}
OutputDir={#MyOutputRoot}
OutputBaseFilename={#MyOutputBaseName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\_internal\app\ChatGPT.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
UsePreviousAppDir=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "zh"; MessagesFile: "{#MyInstallerRoot}\ChineseSimplified.isl"

[CustomMessages]
en.TaskSkills=Install default offline skills (most skills require internet and will not work offline)
zh.TaskSkills=安装默认离线技能（大部分技能需要联网，离线环境下无法使用）
en.TaskChromeHost=Register @chrome native host
zh.TaskChromeHost=注册 @chrome 本机桥接
en.TaskCodexLinks=Register codex:// links for CLI /app
zh.TaskCodexLinks=注册用于 CLI /app 的 codex:// 链接
en.TaskAppShim=Install PowerShell shim for CLI /app (adds a module that overrides Get-AppxPackage; may conflict with the Microsoft Store version of Codex Desktop)
zh.TaskAppShim=安装 CLI /app 的 PowerShell shim（会覆盖 Get-AppxPackage 命令，可能与已安装的商店版 Codex Desktop 冲突）
en.TaskComputerUse=Repair Computer Use plugin layout
zh.TaskComputerUse=修复 Computer Use 插件布局
en.TaskChromeGuide=Open Chrome extension setup guide
zh.TaskChromeGuide=打开 Chrome 扩展设置引导
en.LaunchCodex=Launch Codex
zh.LaunchCodex=启动 Codex

[Files]
Source: "{#MySourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "skills"; Description: "{cm:TaskSkills}"; Flags: unchecked
Name: "chromehost"; Description: "{cm:TaskChromeHost}"; Flags: unchecked
Name: "codexlinks"; Description: "{cm:TaskCodexLinks}"; Flags: unchecked
Name: "appshim"; Description: "{cm:TaskAppShim}"; Flags: unchecked
Name: "computeruse"; Description: "{cm:TaskComputerUse}"; Flags: unchecked
Name: "chromeguide"; Description: "{cm:TaskChromeGuide}"; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Software\Classes\codex"; ValueType: string; ValueName: ""; ValueData: "URL:Codex Protocol"; Flags: uninsdeletekey; Tasks: codexlinks
Root: HKCU; Subkey: "Software\Classes\codex"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Flags: uninsdeletekey; Tasks: codexlinks
Root: HKCU; Subkey: "Software\Classes\codex\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\_internal\app\ChatGPT.exe"",0"; Flags: uninsdeletekey; Tasks: codexlinks
Root: HKCU; Subkey: "Software\Classes\codex\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Codex.cmd"" ""%1"""; Flags: uninsdeletekey; Tasks: codexlinks

[UninstallDelete]
Type: files; Name: "{userdocs}\WindowsPowerShell\Modules\CodexOfflineShim\CodexOfflineShim.psm1"
Type: files; Name: "{userdocs}\WindowsPowerShell\Modules\CodexOfflineShim\CodexOfflineShim.psd1"
Type: files; Name: "{userdocs}\WindowsPowerShell\Modules\CodexOfflineShim\sync-thread.js"
Type: dirifempty; Name: "{userdocs}\WindowsPowerShell\Modules\CodexOfflineShim"
Type: files; Name: "{userdocs}\PowerShell\Modules\CodexOfflineShim\CodexOfflineShim.psm1"
Type: files; Name: "{userdocs}\PowerShell\Modules\CodexOfflineShim\CodexOfflineShim.psd1"
Type: files; Name: "{userdocs}\PowerShell\Modules\CodexOfflineShim\sync-thread.js"
Type: dirifempty; Name: "{userdocs}\PowerShell\Modules\CodexOfflineShim"

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
Name: "{group}\Codex"; Filename: "{app}\Codex.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\_internal\app\ChatGPT.exe"
Name: "{autodesktop}\Codex"; Filename: "{app}\Codex.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\_internal\app\ChatGPT.exe"
Name: "{group}\Setup Codex"; Filename: "{app}\Setup Codex.cmd"; IconFilename: "{app}\_internal\app\ChatGPT.exe"

[Run]
Filename: "{app}\Setup Codex.cmd"; Parameters: "{code:GetSetupCodexArgs} -NoLaunch"; Flags: skipifsilent shellexec
Filename: "{app}\Codex.cmd"; Description: "{cm:LaunchCodex}"; Flags: nowait postinstall skipifsilent shellexec

[Code]
function GetSetupCodexArgs(Param: String): String;
begin
  Result := '-NonInteractive -Language ' + ActiveLanguage;
  if WizardIsTaskSelected('skills') then
    Result := Result + ' -InstallSkillSync';
  if WizardIsTaskSelected('chromehost') then
    Result := Result + ' -RegisterChromeHost';
  if WizardIsTaskSelected('codexlinks') then
    Result := Result + ' -RegisterCodexLinks';
  if WizardIsTaskSelected('appshim') then
    Result := Result + ' -InstallAppShim';
  if WizardIsTaskSelected('computeruse') then
    Result := Result + ' -RepairComputerUse';
  if WizardIsTaskSelected('chromeguide') then
    Result := Result + ' -OpenChromeGuide';
end;
