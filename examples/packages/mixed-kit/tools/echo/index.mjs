import { prefix } from "./helper.mjs";

export async function handler(args) {
  return { isError: false, content: [{ type: "text", text: `${prefix}: ${args.text}` }] };
}
