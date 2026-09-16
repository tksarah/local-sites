import { spawn } from 'node:child_process';
export interface Runner { run(args: string[], timeout?: number): Promise<string> }
export class Docker implements Runner {
  run(args: string[], timeout = 120000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', expired = false;
      const collect = (b: Buffer) => { output = (output + b.toString()).slice(-32000); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 && !expired ? resolve(output.trim()) : reject(new Error(expired ? 'Docker operation timed out' : output || `Docker exited ${code}`)); });
    });
  }
}
