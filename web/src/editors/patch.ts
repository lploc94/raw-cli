export function parseObject(source: string): Record<string, any> {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value as Record<string, any>;
}
/** A JSON object edit as the dashboard saves it: keys the edit removed become `null`, the rest is the edited object. */
export function patch(original: string, source: string) {
  const before = parseObject(original),
    after = parseObject(source);
  return {
    ...Object.fromEntries(
      Object.keys(before)
        .filter((key) => !Object.hasOwn(after, key))
        .map((key) => [key, null]),
    ),
    ...after,
  };
}
