import { BuildTool } from './buildToolInference';
import { inferPackageName } from './runMainLogic';

export type TestFramework =
  | 'scalatest'
  | 'munit'
  | 'specs2'
  | 'utest'
  | 'ziotest'
  | 'unknown';

export interface TestSuiteMatch {
  readonly line: number;
  readonly suiteName: string;
  readonly framework: TestFramework;
}

export interface TestCaseMatch {
  readonly line: number;
  readonly testName: string;
}

const SCALATEST_MARKERS = [
  'AnyFunSuite',
  'AnyFlatSpec',
  'AnyWordSpec',
  'AnyFreeSpec',
  'AnyFunSpec',
  'AnyPropSpec'
] as const;

function inferFramework(extendsClause: string): TestFramework {
  if (SCALATEST_MARKERS.some((marker) => extendsClause.includes(marker))) {
    return 'scalatest';
  }

  if (extendsClause.includes('munit.FunSuite') || extendsClause.includes('FunSuite')) {
    return 'munit';
  }

  if (extendsClause.includes('mutable.Specification') || extendsClause.includes('Specification')) {
    return 'specs2';
  }

  if (extendsClause.includes('utest.TestSuite')) {
    return 'utest';
  }

  if (extendsClause.includes('ZIOSpecDefault')) {
    return 'ziotest';
  }

  return 'unknown';
}

export function detectTestSuites(text: string): TestSuiteMatch[] {
  const lines = text.split(/\r?\n/);
  const suites: TestSuiteMatch[] = [];

  for (let line = 0; line < lines.length; line += 1) {
    const match = lines[line].match(/^\s*(class|object)\s+([A-Za-z_][A-Za-z0-9_]*)\s+extends\s+(.+)$/);
    if (!match?.[2] || !match[3]) {
      continue;
    }

    const framework = inferFramework(match[3]);
    if (framework === 'unknown') {
      continue;
    }

    suites.push({
      line,
      suiteName: match[2],
      framework
    });
  }

  return suites;
}

export function detectTestCases(text: string, framework: TestFramework): TestCaseMatch[] {
  const lines = text.split(/\r?\n/);
  const cases: TestCaseMatch[] = [];

  for (let line = 0; line < lines.length; line += 1) {
    const source = lines[line];

    if (framework === 'scalatest' || framework === 'munit') {
      const match = source.match(/\btest\s*\(\s*"([^"]+)"\s*\)/);
      if (match?.[1]) {
        cases.push({
          line,
          testName: match[1]
        });
      }
      continue;
    }

    if (framework === 'specs2') {
      const match = source.match(/"([^"]+)"\s*>>/);
      if (match?.[1]) {
        cases.push({
          line,
          testName: match[1]
        });
      }
    }
  }

  return cases;
}

function suiteFqn(text: string, suiteName: string): string {
  const packageName = inferPackageName(text);
  return packageName ? `${packageName}.${suiteName}` : suiteName;
}

export function createSuiteTestCommand(
  buildTool: BuildTool,
  filePath: string,
  suiteName: string,
  fileText: string,
  millModule: string
): string {
  const target = suiteFqn(fileText, suiteName);

  if (buildTool === 'scala-cli') {
    return `scala-cli test "${filePath}"`;
  }

  if (buildTool === 'mill') {
    return `mill ${millModule}.testOnly ${target}`;
  }

  return `sbt "testOnly ${target}"`;
}

export function supportsIndividualTargeting(framework: TestFramework): boolean {
  return framework === 'scalatest' || framework === 'munit';
}

export function createIndividualTestCommand(
  buildTool: BuildTool,
  framework: TestFramework,
  filePath: string,
  suiteName: string,
  testName: string,
  fileText: string,
  millModule: string
): string | undefined {
  const target = suiteFqn(fileText, suiteName);

  if (framework === 'scalatest') {
    if (buildTool === 'scala-cli') {
      return `scala-cli test "${filePath}" --test-only "${testName}"`;
    }

    if (buildTool === 'mill') {
      return `mill ${millModule}.testOnly ${target} -- -z '${testName}'`;
    }

    return `sbt 'testOnly ${target} -- -z "${testName}"'`;
  }

  if (framework === 'munit') {
    if (buildTool === 'scala-cli') {
      return `scala-cli test "${filePath}" --test-only "${testName}"`;
    }

    if (buildTool === 'mill') {
      return `mill ${millModule}.testOnly ${target} -- --test "${testName}"`;
    }

    return `sbt 'testOnly ${target} -- --test "${testName}"'`;
  }

  return undefined;
}