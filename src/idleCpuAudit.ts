export interface IdleCpuAuditResult {
  readonly durationSeconds: number;
  readonly cpuDeltaMicros: number;
  readonly approximateCpuPercent: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function runIdleCpuAudit(durationMs: number): Promise<IdleCpuAuditResult> {
  const started = process.cpuUsage();
  await delay(durationMs);

  const delta = process.cpuUsage(started);
  const cpuDeltaMicros = delta.user + delta.system;
  const durationSeconds = durationMs / 1000;
  const approximateCpuPercent = Number(((cpuDeltaMicros / (durationMs * 1000)) * 100).toFixed(4));

  return {
    durationSeconds,
    cpuDeltaMicros,
    approximateCpuPercent
  };
}