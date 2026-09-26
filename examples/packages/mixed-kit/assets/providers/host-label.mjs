let input = "";
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
if (request.protocol_version !== 1) throw new Error("unsupported provider request");
process.stdout.write(JSON.stringify({ value: "mixed-example-host" }) + "\n");
