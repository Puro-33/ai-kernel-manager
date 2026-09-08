import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

if (process.argv.includes('--tree')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stdout.write(`CHILD:${child.pid}\n`);
}
process.stdout.write(`READY:${process.pid}\n`);
const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', line => {
  if (line.trim() === 'quit') {
    process.stdout.write('BYE\n');
    process.exit(0);
  }
  process.stdout.write(`ECHO:${line}\n`);
});
setInterval(() => {}, 1000);
