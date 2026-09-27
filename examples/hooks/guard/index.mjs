let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.event === "PreToolUse") {
    process.stdout.write(JSON.stringify({ decision: "deny", reason: "Review removal commands first" }));
  } else {
    process.stdout.write(JSON.stringify({ message: "Bash command failed" }));
  }
});
