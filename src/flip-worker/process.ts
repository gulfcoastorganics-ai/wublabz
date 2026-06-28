import { spawn } from 'node:child_process';

export interface SpawnResult {
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  timeoutMs: number;
  cwd?: string;
  onStderr?: (chunk: string) => void;
  killGraceMs?: number;
}

export function spawnChecked(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      callback();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalChild(child.pid, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          signalChild(child.pid, 'SIGKILL');
        }
      }, options.killGraceMs ?? 5_000);
    }, options.timeoutMs);

    child.on('error', (error) => {
      settle(() => reject(error));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrChunks.push(chunk);
      options.onStderr?.(text);
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        settle(() => reject(new Error(`${command} timed out after ${options.timeoutMs}ms`)));
        return;
      }
      if (code === 0) {
        settle(() => resolve({ stdout, stderr }));
        return;
      }
      settle(() => {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
      });
    });
  });
}

function signalChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}
