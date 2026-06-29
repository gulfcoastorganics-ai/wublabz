import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';

export const DEFAULT_WUBLABZ_PORT = 3001;
export const WUBLABZ_VERSION = '1.0.0-rc.1';

export interface WubLabzHealth {
  status: 'ok';
  version: string;
  uptimeSeconds: number;
}

export interface PortOwner {
  pid: number;
  command: string;
  source: 'proc' | 'lsof' | 'ss' | 'fuser';
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const execFileAsync = promisify(execFile);

export function resolveWubLabzPort(env: NodeJS.ProcessEnv = process.env): number {
  const rawPort = env.PORT;
  if (!rawPort) return DEFAULT_WUBLABZ_PORT;

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${rawPort}". Use an integer from 1 to 65535.`);
  }

  return port;
}

export function createHealthResponse(startedAtMs: number, nowMs = Date.now()): WubLabzHealth {
  return {
    status: 'ok',
    version: WUBLABZ_VERSION,
    uptimeSeconds: Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  };
}

export function isWubLabzHealthPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;

  const candidate = payload as Record<string, unknown>;

  if (candidate.status === 'ok' && candidate.version === WUBLABZ_VERSION) {
    return true;
  }

  return candidate.ok === true && candidate.service === 'wublabz';
}

export async function probeExistingWubLabz(port: number, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!response.ok) return false;

    return isWubLabzHealthPayload(await response.json());
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function isAddressInUseError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'EADDRINUSE'
  );
}

export function formatStartupDiagnostics(port: number): string {
  return [
    'WubLabz Engine Started',
    `HTTP: http://localhost:${port}`,
    `WebSocket: ws://localhost:${port}`,
    `WebSocket server listening: ws://localhost:${port}`,
    `Health: http://localhost:${port}/health`
  ].join('\n');
}

export function formatPortInUseDiagnostics(port: number, owner: PortOwner | null): string {
  const lines = [`Port ${port} is already in use by another process.`];

  if (owner) {
    lines.push(`PID: ${owner.pid}`);
    lines.push(`Process: ${owner.command}`);
    lines.push(`Stop it and retry: kill ${owner.pid}`);
  } else {
    lines.push('PID: unavailable');
    lines.push('Process: unavailable');
    lines.push(`Find the owner: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  }

  lines.push(`Or run WubLabz on another port: PORT=${port + 1} npm run wublabz`);
  lines.push(
    `If WubPad should use that port, set VITE_WUBLABZ_HTTP_URL=http://localhost:${port + 1} and VITE_WUBLABZ_WS_URL=ws://localhost:${port + 1}.`
  );

  return lines.join('\n');
}

export async function findPortOwner(port: number): Promise<PortOwner | null> {
  const procOwner = await findPortOwnerFromProc(port);
  if (procOwner) return procOwner;

  const lsofOwners = parseLsofPortOwners(await runPortCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']));
  if (lsofOwners[0]) return lsofOwners[0];

  const ssOwners = parseSsPortOwners(await runPortCommand('ss', ['-ltnp', `sport = :${port}`]));
  if (ssOwners[0]) return ssOwners[0];

  const fuserOwners = parseFuserPortOwners(await runPortCommand('fuser', ['-v', `${port}/tcp`]));
  return fuserOwners[0] ?? null;
}

export async function findPortOwnerFromProc(port: number): Promise<PortOwner | null> {
  const inodes = await findListeningSocketInodes(port);
  if (inodes.size === 0) return null;

  const procEntries = await readdir('/proc').catch(() => []);
  const pids = procEntries.filter((entry) => /^\d+$/.test(entry));

  for (const pid of pids) {
    const fdEntries = await readdir(`/proc/${pid}/fd`).catch(() => []);

    for (const fd of fdEntries) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const match = target.match(/^socket:\[(\d+)\]$/);

      if (match && inodes.has(match[1])) {
        return {
          pid: Number(pid),
          command: await readProcessName(pid),
          source: 'proc'
        };
      }
    }
  }

  return null;
}

export function parseProcNetListeningInodes(output: string, port: number): string[] {
  const inodes = new Set<string>();

  for (const line of output.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    const localAddress = columns[1];
    const state = columns[3];
    const inode = columns[9];
    const portHex = localAddress?.split(':')[1];

    if (!portHex || !inode || state !== '0A') continue;
    if (Number.parseInt(portHex, 16) === port) {
      inodes.add(inode);
    }
  }

  return [...inodes];
}

export function parseLsofPortOwners(output: string): PortOwner[] {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const columns = line.split(/\s+/);
      const pid = Number(columns[1]);
      if (!columns[0] || !Number.isInteger(pid)) return [];
      return [{ pid, command: columns[0], source: 'lsof' as const }];
    });
}

export function parseSsPortOwners(output: string): PortOwner[] {
  const owners: PortOwner[] = [];
  const ownerPattern = /"([^"]+)",pid=(\d+)/g;
  let match: RegExpExecArray | null;

  while ((match = ownerPattern.exec(output)) !== null) {
    owners.push({
      command: match[1],
      pid: Number(match[2]),
      source: 'ss'
    });
  }

  return owners;
}

export function parseFuserPortOwners(output: string): PortOwner[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\d/.test(line))
    .flatMap((line) => {
      const columns = line.split(/\s+/);
      const pidIndex = columns.findIndex((column) => /^\d+$/.test(column));
      if (pidIndex === -1) return [];

      const pid = Number(columns[pidIndex]);
      const command = columns[columns.length - 1];
      if (!command || !Number.isInteger(pid)) return [];

      return [{ pid, command, source: 'fuser' as const }];
    });
}

async function runPortCommand(command: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 1000 });
    return `${stdout}${stderr}`;
  } catch (error) {
    const processError = error as { stdout?: string; stderr?: string };
    return `${processError.stdout ?? ''}${processError.stderr ?? ''}`;
  }
}

async function findListeningSocketInodes(port: number): Promise<Set<string>> {
  const tcp = await readFile('/proc/net/tcp', 'utf8').catch(() => '');
  const tcp6 = await readFile('/proc/net/tcp6', 'utf8').catch(() => '');

  return new Set([...parseProcNetListeningInodes(tcp, port), ...parseProcNetListeningInodes(tcp6, port)]);
}

async function readProcessName(pid: string): Promise<string> {
  const comm = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
  if (comm.trim()) return comm.trim();

  const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
  return cmdline.split('\0').find(Boolean) ?? 'unknown';
}
