import { spawn } from 'node:child_process';
export interface Runner { run(args: string[], timeout?: number, maxOutput?: number): Promise<string> }
export class Docker implements Runner {
  run(args: string[], timeout = 120000, maxOutput = 32000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '', expired = false, overflow = false;
      child.stdout.on('data', (b: Buffer) => {
        if (maxOutput > 32000 && output.length + b.length > maxOutput) { overflow = true; child.kill('SIGKILL'); }
        output = (output + b.toString()).slice(-maxOutput);
      });
      child.stderr.on('data', (b: Buffer) => {
        errors = (errors + b.toString()).slice(-32000);
        if (maxOutput <= 32000) output = (output + b.toString()).slice(-maxOutput);
      });
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 && !expired && !overflow ? resolve(output.trim()) : reject(new Error(expired ? 'Docker operation timed out' : overflow ? 'Docker output exceeds limit' : (maxOutput > 32000 ? errors || output : output) || `Docker exited ${code}`)); });
    });
  }
}
