// src/tools/bundled/list_skills/index.ts
async function handler(_args, context) {
  return { isError: false, content: [{ type: "json", value: {
    skills: (context.skills ?? []).map(({ name, description }) => ({ name, description }))
  } }] };
}
export {
  handler
};
