import type { ModelMessage } from "./types.js";

function historicalResult(message: Extract<ModelMessage, { role: "tool" }>): string {
  const content = message.result.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "json") return JSON.stringify(block.value);
    return `[Historical ${block.mimeType} image, ${block.byteSize ?? Buffer.from(block.data, "base64").length} bytes; reload the image if needed]`;
  }).join("\n");
  return `[Historical tool result: ${message.name}, call ${message.callId}, ${message.result.isError ? "error" : "success"}]\n${content}`;
}

export function projectReplayMessages(messages: readonly ModelMessage[], replayBefore: number): ModelMessage[] {
  if (replayBefore <= 0) return [...messages];
  return messages.flatMap((message, index): ModelMessage[] => {
    if (index >= replayBefore || message.role === "user") return [message];
    if (message.role === "tool") return [{ role: "user", content: historicalResult(message) }];
    const calls = message.toolCalls.map((call) =>
      `[Historical tool call: ${call.name}, call ${call.id}]\nArguments: ${call.rawArguments ?? JSON.stringify(call.arguments)}`);
    return [{ role: "assistant", text: [message.text, ...calls].filter(Boolean).join("\n")
      || "[Historical assistant response contained no portable text]", toolCalls: [] }];
  });
}
