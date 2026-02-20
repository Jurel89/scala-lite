import { BuildTool } from './buildToolInference';

export interface TaskProfile {
  readonly name: string;
  readonly buildTool: BuildTool;
  readonly workingDirectory: string;
  readonly runCommand: string;
  readonly testCommand: string;
  readonly envVars: Record<string, string>;
  readonly jvmOpts: string[];
  readonly preBuildCommand: string;
}

export interface CommandTemplateValues {
  readonly mainClass?: string;
  readonly suiteName?: string;
  readonly testName?: string;
  readonly filePath?: string;
  readonly jvmOpts?: string;
}

export function renderTemplate(template: string, values: CommandTemplateValues): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = values[key as keyof CommandTemplateValues];
    return typeof value === 'string' ? value : '';
  });
}

export function generateDefaultProfile(buildTool: BuildTool): TaskProfile {
  if (buildTool === 'mill') {
    return {
      name: 'Default (mill)',
      buildTool,
      workingDirectory: '.',
      runCommand: 'mill __.runMain {{mainClass}}',
      testCommand: 'mill __.testOnly {{suiteName}}',
      envVars: {},
      jvmOpts: [],
      preBuildCommand: ''
    };
  }

  if (buildTool === 'scala-cli') {
    return {
      name: 'Default (scala-cli)',
      buildTool,
      workingDirectory: '.',
      runCommand: 'scala-cli run "{{filePath}}"',
      testCommand: 'scala-cli test "{{filePath}}"',
      envVars: {},
      jvmOpts: [],
      preBuildCommand: ''
    };
  }

  return {
    name: 'Default (sbt)',
    buildTool: buildTool === 'none' ? 'sbt' : buildTool,
    workingDirectory: '.',
    runCommand: 'sbt "runMain {{mainClass}}"',
    testCommand: 'sbt "testOnly {{suiteName}}"',
    envVars: {},
    jvmOpts: [],
    preBuildCommand: ''
  };
}

function envPrefix(envVars: Record<string, string>): string {
  const entries = Object.entries(envVars);
  if (entries.length === 0) {
    return '';
  }

  return `${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')} `;
}

export function applyProfileCommandShape(command: string, profile: TaskProfile): string {
  const parts: string[] = [];

  if (profile.workingDirectory && profile.workingDirectory !== '.') {
    parts.push(`cd ${JSON.stringify(profile.workingDirectory)}`);
  }

  if (profile.preBuildCommand) {
    parts.push(profile.preBuildCommand);
  }

  const env = envPrefix(profile.envVars);
  const finalCommand = `${env}${command}`.trim();
  parts.push(finalCommand);

  return parts.join(' && ');
}