import { hostname, platform } from "node:os";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 65537) throw new Error("request too large");
}
const request = JSON.parse(input);
if (request.protocol_version !== 1 || typeof request.name !== "string"
  || !request.params || !["hostname", "platform"].includes(request.params.field)) {
  throw new Error("expected protocol 1 and params.field hostname or platform");
}
const value = request.params.field === "hostname" ? hostname() : platform();
process.stdout.write(JSON.stringify({ value, observed_at: new Date().toISOString() }) + "\n");
