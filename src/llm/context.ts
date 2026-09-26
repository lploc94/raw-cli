export function effectiveInputBudget(contextWindow: number, outputReserve: number): number {
  return contextWindow - outputReserve - Math.max(64, Math.ceil(contextWindow * 0.05));
}
