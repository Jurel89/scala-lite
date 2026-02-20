import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BuildTool } from './buildToolInference';
import { parseBuildOutputLine } from './buildOutputParser';
import { CommandTemplateValues, renderTemplate, TaskProfile } from './profileCore';

export interface BuildAdapter {
  readonly id: string;
  readonly displayName: string;
  detect(workspaceRoot: string): Promise<boolean>;
  runMainCommand(mainClass: string, filePath: string, profile: TaskProfile): string;
  runTestCommand(suiteFQN: string, testName: string | undefined, filePath: string, profile: TaskProfile): string;
  parseErrors(output: string): vscode.Diagnostic[];
  cleanCommand?(): string;
}

function renderProfileTemplate(profile: TaskProfile, template: string, values: CommandTemplateValues): string {
  return renderTemplate(template, {
    ...values,
    jvmOpts: profile.jvmOpts.join(' ')
  }).trim();
}

function diagnosticsFromOutput(output: string): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (const line of output.split(/\r?\n/)) {
    const parsed = parseBuildOutputLine(line);
    if (!parsed) {
      continue;
    }

    const range = new vscode.Range(
      Math.max(0, parsed.line - 1),
      Math.max(0, parsed.column - 1),
      Math.max(0, parsed.line - 1),
      Math.max(0, parsed.column)
    );
    diagnostics.push(
      new vscode.Diagnostic(
        range,
        parsed.message,
        parsed.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
      )
    );
  }

  return diagnostics;
}

class SbtAdapter implements BuildAdapter {
  public readonly id = 'sbt';
  public readonly displayName = 'sbt';

  public async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await fs.access(path.join(workspaceRoot, 'build.sbt'));
      return true;
    } catch {
      return false;
    }
  }

  public runMainCommand(mainClass: string, filePath: string, profile: TaskProfile): string {
    const template = profile.runCommand || 'sbt "runMain {{mainClass}}"';
    return renderProfileTemplate(profile, template, { mainClass, filePath });
  }

  public runTestCommand(suiteFQN: string, testName: string | undefined, filePath: string, profile: TaskProfile): string {
    if (testName && /testOnly/i.test(profile.testCommand || '')) {
      const withName = renderProfileTemplate(profile, profile.testCommand, {
        suiteName: suiteFQN,
        testName,
        filePath
      });
      if (withName.trim().length > 0) {
        return withName;
      }
    }

    const template = profile.testCommand || 'sbt "testOnly {{suiteName}}"';
    return renderProfileTemplate(profile, template, {
      suiteName: suiteFQN,
      testName,
      filePath
    });
  }

  public parseErrors(output: string): vscode.Diagnostic[] {
    return diagnosticsFromOutput(output);
  }

  public cleanCommand(): string {
    return 'sbt clean';
  }
}

class MillAdapter implements BuildAdapter {
  public readonly id = 'mill';
  public readonly displayName = 'Mill';

  public async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await fs.access(path.join(workspaceRoot, 'build.sc'));
      return true;
    } catch {
      return false;
    }
  }

  public runMainCommand(mainClass: string, filePath: string, profile: TaskProfile): string {
    const template = profile.runCommand || 'mill __.runMain {{mainClass}}';
    return renderProfileTemplate(profile, template, { mainClass, filePath });
  }

  public runTestCommand(suiteFQN: string, testName: string | undefined, filePath: string, profile: TaskProfile): string {
    const template = profile.testCommand || 'mill __.testOnly {{suiteName}}';
    return renderProfileTemplate(profile, template, {
      suiteName: suiteFQN,
      testName,
      filePath
    });
  }

  public parseErrors(output: string): vscode.Diagnostic[] {
    return diagnosticsFromOutput(output);
  }

  public cleanCommand(): string {
    return 'mill __.clean';
  }
}

class ScalaCliAdapter implements BuildAdapter {
  public readonly id = 'scala-cli';
  public readonly displayName = 'Scala CLI';

  public async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await fs.access(path.join(workspaceRoot, '.scala-build'));
      return true;
    } catch {
      return false;
    }
  }

  public runMainCommand(mainClass: string, filePath: string, profile: TaskProfile): string {
    const template = profile.runCommand || 'scala-cli run "{{filePath}}"';
    return renderProfileTemplate(profile, template, { mainClass, filePath });
  }

  public runTestCommand(suiteFQN: string, testName: string | undefined, filePath: string, profile: TaskProfile): string {
    const template = profile.testCommand || 'scala-cli test "{{filePath}}"';
    return renderProfileTemplate(profile, template, {
      suiteName: suiteFQN,
      testName,
      filePath
    });
  }

  public parseErrors(output: string): vscode.Diagnostic[] {
    return diagnosticsFromOutput(output);
  }
}

class CustomAdapter implements BuildAdapter {
  public readonly id = 'custom';
  public readonly displayName = 'Custom';

  public async detect(): Promise<boolean> {
    return true;
  }

  public runMainCommand(mainClass: string, filePath: string, profile: TaskProfile): string {
    const template = profile.runCommand || 'sbt "runMain {{mainClass}}"';
    return renderProfileTemplate(profile, template, { mainClass, filePath });
  }

  public runTestCommand(suiteFQN: string, testName: string | undefined, filePath: string, profile: TaskProfile): string {
    const template = profile.testCommand || 'sbt "testOnly {{suiteName}}"';
    return renderProfileTemplate(profile, template, {
      suiteName: suiteFQN,
      testName,
      filePath
    });
  }

  public parseErrors(output: string): vscode.Diagnostic[] {
    return diagnosticsFromOutput(output);
  }
}

export class BuildAdapterRegistry {
  private readonly adapters = new Map<string, BuildAdapter>();

  public register(adapter: BuildAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public get(id: string): BuildAdapter | undefined {
    return this.adapters.get(id);
  }

  public resolveFor(buildTool: BuildTool, profile: TaskProfile | undefined): BuildAdapter {
    if (profile && (profile.runCommand.trim().length > 0 || profile.testCommand.trim().length > 0)) {
      return this.adapters.get('custom') ?? this.adapters.get('sbt')!;
    }

    if (buildTool === 'mill' || buildTool === 'scala-cli' || buildTool === 'sbt') {
      return this.adapters.get(buildTool) ?? this.adapters.get('sbt')!;
    }

    return this.adapters.get('sbt')!;
  }
}

const defaultRegistry = new BuildAdapterRegistry();
defaultRegistry.register(new SbtAdapter());
defaultRegistry.register(new MillAdapter());
defaultRegistry.register(new ScalaCliAdapter());
defaultRegistry.register(new CustomAdapter());

export function getBuildAdapterRegistry(): BuildAdapterRegistry {
  return defaultRegistry;
}
