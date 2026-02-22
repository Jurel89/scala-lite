export interface JsStringTableStats {
  readonly entryCount: number;
  readonly estimatedByteSavings: number;
}

export class JsStringTable {
  private readonly table = new Map<string, string>();
  private estimatedByteSavings = 0;

  public intern(value: string): string {
    const existing = this.table.get(value);
    if (existing !== undefined) {
      this.estimatedByteSavings += Buffer.byteLength(value, 'utf8');
      return existing;
    }

    this.table.set(value, value);
    return value;
  }

  public clear(): void {
    this.table.clear();
    this.estimatedByteSavings = 0;
  }

  public getStats(): JsStringTableStats {
    return {
      entryCount: this.table.size,
      estimatedByteSavings: this.estimatedByteSavings
    };
  }
}
