export type BuildTool = 'sbt' | 'mill' | 'scala-cli' | 'maven' | 'gradle' | 'none';

export interface DetectionSignals {
  readonly hasSbtRoot: boolean;
  readonly hasSbtImmediateChild: boolean;
  readonly hasSbtProjectBuildPropertiesRoot: boolean;
  readonly hasSbtProjectBuildPropertiesImmediateChild: boolean;
  readonly hasMillRoot: boolean;
  readonly hasScalaBuildDirectoryRoot: boolean;
  readonly scalaSourceSnippets: readonly string[];
  readonly mavenPomSnippets: readonly string[];
  readonly gradleBuildSnippets: readonly string[];
}

export function inferBuildToolFromSignals(signals: DetectionSignals): BuildTool {
  const hasSbt =
    signals.hasSbtRoot ||
    signals.hasSbtImmediateChild ||
    signals.hasSbtProjectBuildPropertiesRoot ||
    signals.hasSbtProjectBuildPropertiesImmediateChild;

  if (hasSbt) {
    return 'sbt';
  }

  if (signals.hasMillRoot) {
    return 'mill';
  }

  const hasScalaCliDirective = signals.scalaSourceSnippets.some((content) => /(^|\n)\s*\/\/>\s+using\b/i.test(content));
  if (signals.hasScalaBuildDirectoryRoot || hasScalaCliDirective) {
    return 'scala-cli';
  }

  const hasMavenScalaArtifact = signals.mavenPomSnippets.some((content) => /<artifactId>[^<]*scala[^<]*<\/artifactId>/i.test(content));
  if (hasMavenScalaArtifact) {
    return 'maven';
  }

  const hasGradleScalaPlugin = signals.gradleBuildSnippets.some((content) => {
    return (
      /id\s*\(?\s*['"]scala['"]\s*\)?/i.test(content) ||
      /apply\s+plugin:\s*['"]scala['"]/i.test(content) ||
      /org\.scala-lang/i.test(content) ||
      /scala-library/i.test(content)
    );
  });

  if (hasGradleScalaPlugin) {
    return 'gradle';
  }

  return 'none';
}