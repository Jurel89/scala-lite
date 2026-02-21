import Module from 'node:module';

export const vscodeMock = {
  Location: class Location {
    public range: any;
    constructor(public uri: any, public rangeOrPosition: any) {
      this.range = rangeOrPosition;
      if (this.range && !this.range.start) {
        this.range.start = rangeOrPosition;
      }
    }
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => p }),
    parse: (value: string) => ({
      scheme: value.split(':')[0] ?? '',
      fsPath: value,
      toString: () => value
    })
  },
  Position: class Position {
    constructor(public line: number, public character: number) {}
  },
  Range: class Range {
    constructor(public start: any, public end: any) {}
  },
  MarkdownString: class MarkdownString {
    public value: string;
    constructor(value?: string) {
      this.value = value ?? '';
    }
    appendMarkdown(text: string): void {
      this.value += text;
    }
    appendCodeblock(code: string, language?: string): void {
      this.value += `\n\
\u0060\u0060\u0060${language ?? ''}\n${code}\n\
\u0060\u0060\u0060\n`;
    }
  },
  Hover: class Hover {
    public contents: any[];
    public range?: any;

    constructor(contents: any, range?: any) {
      this.contents = Array.isArray(contents) ? contents : [contents];
      this.range = range;
    }
  },
  window: {
    showInformationMessage: async () => undefined,
    showQuickPick: async (items: any[]) => items[0],
    setStatusBarMessage: () => ({ dispose: () => {} }),
    createOutputChannel: () => ({ appendLine: () => {} })
  },
  workspace: {
    __config: {} as Record<string, any>,
    __documents: {} as Record<string, string[]>,
    getConfiguration: (section?: string) => ({
      get: (key: string, defaultValue?: any) => {
        const fullKey = section ? `${section}.${key}` : key;
        const value = (vscodeMock.workspace.__config as Record<string, any>)[fullKey];
        return value !== undefined ? value : defaultValue;
      }
    }),
    onDidSaveTextDocument: () => ({ dispose: () => {} }),
    findFiles: async () => [],
    getWorkspaceFolder: () => ({ uri: { fsPath: '/workspace' } }),
    asRelativePath: (uri: any) => {
      const fsPath = typeof uri === 'string' ? uri : uri?.fsPath ?? '';
      if (fsPath.startsWith('/workspace/')) {
        return fsPath.replace('/workspace/', '');
      }
      return fsPath;
    },
    openTextDocument: async (uri: any) => {
      const lines = (vscodeMock.workspace.__documents as Record<string, string[]>)[uri.fsPath] ?? [];
      return {
        lineCount: lines.length,
        lineAt: (line: number) => ({ text: lines[line] ?? '' })
      };
    }
  },
  CancellationTokenSource: class CancellationTokenSource {
    token = { isCancellationRequested: false };
  },
  ThemeIcon: class ThemeIcon {
    constructor(public id: string) {}
  },
  ThemeColor: class ThemeColor {
    constructor(public id: string) {}
  },
  QuickPickItemKind: {
    Separator: -1
  },
  l10n: {
    t: (str: string) => str
  }
};

const originalRequire = (Module.prototype as any).require;
(Module.prototype as any).require = function (id: string) {
  if (id === 'vscode') {
    return vscodeMock;
  }
  return originalRequire.apply(this, arguments);
};
