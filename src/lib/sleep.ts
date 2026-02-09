export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function jitter(minMs: number, maxMs: number): number {
  const min = Math.min(minMs, maxMs);
  const max = Math.max(minMs, maxMs);
  return Math.floor(min + Math.random() * (max - min + 1));
}
