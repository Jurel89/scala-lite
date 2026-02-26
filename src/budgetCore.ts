export type BudgetStopReason = 'time' | 'cancelled';

export interface BudgetRunResult<T> {
  readonly status: 'completed' | 'stopped';
  readonly value?: T;
  readonly elapsedMs: number;
  readonly stopReason?: BudgetStopReason;
  readonly cpuDeltaMicros: number;
}

export interface BudgetRunnerOptions {
  readonly operationName: string;
  readonly timeBudgetMs: number;
  readonly now?: () => number;
  readonly cancellationRequested?: () => boolean;
}

export class BudgetRunner<T> {
  private static readonly CANCELLATION_POLL_INTERVAL_MS = 500;
  private readonly operationName: string;
  private readonly timeBudgetMs: number;
  private readonly now: () => number;
  private readonly cancellationRequested: () => boolean;

  public constructor(options: BudgetRunnerOptions) {
    this.operationName = options.operationName;
    this.timeBudgetMs = Math.max(1, options.timeBudgetMs);
    this.now = options.now ?? Date.now;
    this.cancellationRequested = options.cancellationRequested ?? (() => false);
  }

  public async run(executor: () => Promise<T>): Promise<BudgetRunResult<T>> {
    const startedAt = this.now();
    const cpuStart = process.cpuUsage();

    if (this.cancellationRequested()) {
      return {
        status: 'stopped',
        elapsedMs: 0,
        stopReason: 'cancelled',
        cpuDeltaMicros: 0
      };
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let cpuSamplingHandle: ReturnType<typeof setInterval> | undefined;
    let timeoutTriggered = false;

    const timeoutPromise = new Promise<{ readonly timeout: true }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timeoutTriggered = true;
        resolve({ timeout: true });
      }, this.timeBudgetMs);
    });

    cpuSamplingHandle = setInterval(() => {
      if (this.cancellationRequested()) {
        timeoutTriggered = true;
      }
    }, BudgetRunner.CANCELLATION_POLL_INTERVAL_MS);

    const executionPromise = executor().then((value) => ({ value }));
    const outcome = await Promise.race([executionPromise, timeoutPromise]);

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (cpuSamplingHandle) {
      clearInterval(cpuSamplingHandle);
    }

    const elapsedMs = Math.max(0, this.now() - startedAt);
    const cpuEnd = process.cpuUsage(cpuStart);
    const cpuDeltaMicros = Math.max(0, cpuEnd.user + cpuEnd.system);

    if ('timeout' in outcome || timeoutTriggered) {
      return {
        status: 'stopped',
        elapsedMs,
        stopReason: this.cancellationRequested() ? 'cancelled' : 'time',
        cpuDeltaMicros
      };
    }

    return {
      status: 'completed',
      value: outcome.value,
      elapsedMs,
      cpuDeltaMicros
    };
  }

  public getOperationName(): string {
    return this.operationName;
  }

  public getTimeBudgetMs(): number {
    return this.timeBudgetMs;
  }
}

export interface BudgetExtendInput<T> {
  readonly operationName: string;
  readonly initialTimeBudgetMs: number;
  readonly executeWithBudget: (timeBudgetMs: number) => Promise<BudgetRunResult<T>>;
  readonly requestAction: (context: {
    operationName: string;
    elapsedMs: number;
    nextBudgetMs: number;
  }) => Promise<'show-partial' | 'extend' | 'cancel'>;
}

export async function runWithBudgetExtension<T>(input: BudgetExtendInput<T>): Promise<{
  readonly result: BudgetRunResult<T>;
  readonly finalBudgetMs: number;
}> {
  let currentBudgetMs = Math.max(1, input.initialTimeBudgetMs);

  while (true) {
    const result = await input.executeWithBudget(currentBudgetMs);
    if (result.status === 'completed' || result.stopReason !== 'time') {
      return {
        result,
        finalBudgetMs: currentBudgetMs
      };
    }

    const nextBudgetMs = currentBudgetMs * 2;
    const action = await input.requestAction({
      operationName: input.operationName,
      elapsedMs: result.elapsedMs,
      nextBudgetMs
    });

    if (action === 'extend') {
      currentBudgetMs = nextBudgetMs;
      continue;
    }

    return {
      result,
      finalBudgetMs: currentBudgetMs
    };
  }
}
