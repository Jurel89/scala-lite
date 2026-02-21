import type { IndexedSymbol } from './symbolIndex';

const SYMBOL_KIND_ORDER: Record<IndexedSymbol['symbolKind'], number> = {
  package: 0,
  class: 1,
  trait: 2,
  object: 3,
  type: 4,
  def: 5,
  val: 6,
  param: 7
};

export function compareSymbols(
  left: IndexedSymbol,
  right: IndexedSymbol,
  primaryComparator?: (left: IndexedSymbol, right: IndexedSymbol) => number
): number {
  if (primaryComparator) {
    const primaryOrder = primaryComparator(left, right);
    if (primaryOrder !== 0) {
      return primaryOrder;
    }
  }

  const fileOrder = left.filePath.localeCompare(right.filePath);
  if (fileOrder !== 0) {
    return fileOrder;
  }

  if (left.lineNumber !== right.lineNumber) {
    return left.lineNumber - right.lineNumber;
  }

  const leftKindOrder = SYMBOL_KIND_ORDER[left.symbolKind] ?? Number.MAX_SAFE_INTEGER;
  const rightKindOrder = SYMBOL_KIND_ORDER[right.symbolKind] ?? Number.MAX_SAFE_INTEGER;
  if (leftKindOrder !== rightKindOrder) {
    return leftKindOrder - rightKindOrder;
  }

  return left.symbolName.localeCompare(right.symbolName);
}

export function compareSymbolsWithCursorProximity(
  cursorLine: number,
  primaryComparator?: (left: IndexedSymbol, right: IndexedSymbol) => number
): (left: IndexedSymbol, right: IndexedSymbol) => number {
  return (left, right) => {
    const leftDistance = Math.abs(left.lineNumber - cursorLine);
    const rightDistance = Math.abs(right.lineNumber - cursorLine);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }

    return compareSymbols(left, right, primaryComparator);
  };
}
