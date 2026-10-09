/** Bound the preview BEFORE serialization; never stringify the full trace for HTML. */
export function previewJson(value: unknown): { text: string; truncated: boolean } {
  let nodes = 1500;
  let chars = 16000;
  let truncated = false;
  const seen = new WeakSet<object>();
  const omitted = (): string => { truncated = true; return "[preview omitted]"; };
  const string = (input: string): string => {
    const length = Math.min(2000, Math.max(0, chars));
    chars -= Math.min(length, input.length);
    return input.length <= length ? input : input.slice(0, length) + omitted();
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (--nodes < 0 || chars <= 0 || depth > 8) return omitted();
    if (typeof input === "string") return string(input);
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return omitted();
    seen.add(input);
    if (Array.isArray(input)) {
      const output: unknown[] = [];
      let index = 0;
      for (; index < input.length && index < 50 && nodes > 0 && chars > 0; index++) {
        output.push(visit(input[index], depth + 1));
      }
      if (index < input.length) { truncated = true; output.push({ previewOmittedItems: input.length - index }); }
      return output;
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let count = 0;
    for (const key of Object.keys(input)) {
      if (count++ >= 50 || nodes <= 0 || chars <= 0) { output["[preview]"] = omitted(); break; }
      output[string(key)] = visit((input as Record<string, unknown>)[key], depth + 1);
    }
    return output;
  };
  const projected = visit(value, 0);
  return { text: JSON.stringify(projected, null, 2) ?? "null", truncated };
}
