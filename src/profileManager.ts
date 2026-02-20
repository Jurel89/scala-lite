import * as vscode from 'vscode';
import { BuildTool } from './buildToolInference';
import {
  generateDefaultProfile,
  TaskProfile
} from './profileCore';

const ACTIVE_PROFILE_CONFIG_KEY = 'activeProfile';

export const COMMAND_SWITCH_PROFILE = 'scalaLite.switchProfile';
export const COMMAND_EDIT_PROFILES = 'scalaLite.editProfiles';

interface ScalaLiteWorkspaceConfig {
  readonly profiles?: TaskProfile[];
  readonly activeProfile?: string;
  readonly [key: string]: unknown;
}

function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function configUriFor(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, '.vscode', 'scala-lite.json');
}

async function readWorkspaceConfig(folder: vscode.WorkspaceFolder): Promise<ScalaLiteWorkspaceConfig> {
  try {
    const raw = await vscode.workspace.fs.readFile(configUriFor(folder));
    return JSON.parse(Buffer.from(raw).toString('utf8')) as ScalaLiteWorkspaceConfig;
  } catch {
    return {};
  }
}

async function writeWorkspaceConfig(folder: vscode.WorkspaceFolder, config: ScalaLiteWorkspaceConfig): Promise<void> {
  const parent = vscode.Uri.joinPath(folder.uri, '.vscode');
  await vscode.workspace.fs.createDirectory(parent);
  await vscode.workspace.fs.writeFile(configUriFor(folder), Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));
}

export class ProfileManager implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly getDetectedBuildTool: () => BuildTool;
  private readonly statusBarItem: vscode.StatusBarItem;
  private profiles: TaskProfile[] = [];
  private activeProfileName: string | undefined;

  public constructor(context: vscode.ExtensionContext, getDetectedBuildTool: () => BuildTool) {
    this.context = context;
    this.getDetectedBuildTool = getDetectedBuildTool;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.statusBarItem.command = COMMAND_SWITCH_PROFILE;
    this.context.subscriptions.push(this.statusBarItem);
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }

  public async initialize(): Promise<void> {
    await this.loadProfiles();
    this.registerCommands();
    this.statusBarItem.show();
    this.renderStatus();
  }

  public async reloadFromWorkspaceConfig(): Promise<void> {
    await this.loadProfiles();
    this.renderStatus();
  }

  public getActiveProfile(): TaskProfile {
    const selected = this.profiles.find((profile) => profile.name === this.activeProfileName);
    return selected ?? this.profiles[0] ?? generateDefaultProfile(this.getDetectedBuildTool());
  }

  private registerCommands(): void {
    const switchDisposable = vscode.commands.registerCommand(COMMAND_SWITCH_PROFILE, async () => {
      await this.switchProfileCommand();
    });

    const editDisposable = vscode.commands.registerCommand(COMMAND_EDIT_PROFILES, async () => {
      await this.editProfilesCommand();
    });

    this.context.subscriptions.push(switchDisposable, editDisposable);
  }

  private async loadProfiles(): Promise<void> {
    const folder = getPrimaryWorkspaceFolder();
    if (!folder) {
      this.profiles = [generateDefaultProfile(this.getDetectedBuildTool())];
      this.activeProfileName = this.profiles[0].name;
      return;
    }

    const config = await readWorkspaceConfig(folder);
    const configuredProfiles = Array.isArray(config.profiles) ? config.profiles : [];

    if (configuredProfiles.length === 0) {
      const defaultProfile = generateDefaultProfile(this.getDetectedBuildTool());
      this.profiles = [defaultProfile];
      await writeWorkspaceConfig(folder, {
        ...config,
        profiles: [defaultProfile]
      });
    } else {
      this.profiles = configuredProfiles;
    }

    const configuredFromFile = typeof config.activeProfile === 'string' ? config.activeProfile : undefined;
    const configuredFromSettings = vscode.workspace.getConfiguration('scalaLite').get<string>(ACTIVE_PROFILE_CONFIG_KEY);
    const configuredActive = configuredFromFile ?? configuredFromSettings;
    const fallbackName = this.profiles[0]?.name;
    this.activeProfileName = this.profiles.some((item) => item.name === configuredActive) ? configuredActive : fallbackName;

    await vscode.workspace.getConfiguration('scalaLite').update(
      ACTIVE_PROFILE_CONFIG_KEY,
      this.activeProfileName,
      vscode.ConfigurationTarget.Workspace
    );
  }

  private async switchProfileCommand(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      this.profiles.map((profile) => ({
        label: profile.name,
        description: profile.name === this.activeProfileName ? vscode.l10n.t('✓ Active') : '',
        profile
      })),
      {
        title: vscode.l10n.t('Scala Lite: Switch Profile')
      }
    );

    if (!picked) {
      return;
    }

    this.activeProfileName = picked.profile.name;
    await vscode.workspace.getConfiguration('scalaLite').update(
      ACTIVE_PROFILE_CONFIG_KEY,
      this.activeProfileName,
      vscode.ConfigurationTarget.Workspace
    );

    this.renderStatus();
  }

  private async editProfilesCommand(): Promise<void> {
    const folder = getPrimaryWorkspaceFolder();
    if (!folder) {
      return;
    }

    const configUri = configUriFor(folder);
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(configUri);
    } catch {
      const defaultProfile = this.getActiveProfile();
      await writeWorkspaceConfig(folder, {
        profiles: [defaultProfile]
      });
      document = await vscode.workspace.openTextDocument(configUri);
    }

    const editor = await vscode.window.showTextDocument(document);
    const index = document.getText().indexOf('"profiles"');
    if (index >= 0) {
      const position = document.positionAt(index);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
    }
  }

  private renderStatus(): void {
    const profile = this.getActiveProfile();
    this.statusBarItem.text = `$(settings) ${profile.name}`;
    this.statusBarItem.tooltip = vscode.l10n.t('Active Scala Lite profile ({0})', profile.buildTool);
  }
}