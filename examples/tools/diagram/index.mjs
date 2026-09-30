export async function handler(args, context) {
  if (new TextEncoder().encode(args.source).byteLength > 16 * 1024) {
    return { isError: true, content: [{ type: "text", text: "Diagram source exceeds 16 KiB." }] };
  }
  const block = { id: "diagram", kind: "mermaid", source: args.source,
    ...(args.title ? { title: args.title } : {}), ...(args.fallback ? { fallback: args.fallback } : {}) };
  await context.panels.update("diagram", { op: "replace", document: { blocks: [block] } });
  return { content: [{ type: "text", text: args.fallback || "Diagram published. Source is available in the diagram view." }] };
}
