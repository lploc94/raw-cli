// src/tools/bundled/load_skill/index.ts
async function handler(args, context) {
  const skill = context.skills?.find((item) => item.name === args.name);
  if (!skill) return { isError: true, code: "unknown_skill", content: [{ type: "text", text: "skill is not selected" }] };
  return { isError: false, content: [{ type: "text", text: skill.markdown }] };
}
export {
  handler
};
