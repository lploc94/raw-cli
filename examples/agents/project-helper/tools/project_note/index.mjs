export async function handler(_args, context) {
  return { content: [{ type: "text", text: `Project directory: ${context.cwd}` }] };
}
