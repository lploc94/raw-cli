import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mode = process.argv[2];
if (mode === 'early') { process.stdin.destroy(); process.exit(1); }
let input = '';
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
if (process.env.VAR_COUNT) appendFileSync(process.env.VAR_COUNT, 'x');
switch (mode) {
  case 'bad': console.log('bad secret bytes'); break;
  case 'extra': console.log('{"value":1}\n{"value":2}'); break;
  case 'utf8': process.stdout.write(Buffer.from([255])); break;
  case 'exit': console.error('private stderr'); process.exitCode = 2; break;
  case 'overflow': process.stdout.write('x'.repeat(100000)); break;
  case 'date': console.log(JSON.stringify({value:1, observed_at:'yesterday'})); break;
  case 'unknown': console.log(JSON.stringify({value:1, other:true})); break;
  case 'hang': process.on('SIGTERM', () => {}); setInterval(() => {}, 100); break;
  case 'descendant': spawn(process.execPath, ['-e', 'setInterval(()=>{},100)'], { stdio: ['ignore', 'inherit', 'inherit'] }); process.exit(0); break;
  default: console.log(JSON.stringify({ value: { request, env: process.env.VAR_TEST, cwd: process.cwd() } }));
}
