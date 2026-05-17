#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout } from 'node:timers/promises';

const ROOT = new URL('../../', import.meta.url);
const PORT = Number(process.env.PORT ?? 0);

async function getFreePort() {
  if (PORT > 0) return PORT;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        return reject(new Error('Failed to allocate ephemeral port'));
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return;
    } catch {
      // ignore
    }
    await setTimeout(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function spawnServer(port) {
  const tsx = new URL('../../node_modules/.bin/tsx', import.meta.url).pathname;
  const proc = spawn(tsx, ['src/server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  proc.on('exit', (code, signal) => {
    if (code !== null) {
      console.log(`[e2e] server exited with code ${code}`);
    }
    if (signal) {
      console.log(`[e2e] server killed by signal ${signal}`);
    }
  });
  return proc;
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  const serverProc = spawnServer(port);
  let serverExited = false;

  serverProc.on('exit', () => { serverExited = true; });

  try {
    await waitForReady(`${baseUrl}/`);
    console.log(`[e2e] server ready at ${baseUrl}`);

    const result = spawn('node', ['tests/e2e/designer.mjs', baseUrl], {
      cwd: ROOT,
      env: {
        ...process.env,
        BASE_URL: baseUrl,
      },
      stdio: 'inherit',
    });

    const exitCode = await new Promise((resolve) => {
      result.on('exit', resolve);
      result.on('error', (err) => {
        console.error('[e2e] test process failed', err);
        resolve(1);
      });
    });

    if (exitCode !== 0) {
      throw new Error(`Designer E2E failed with exit code ${exitCode}`);
    }
  } finally {
    if (!serverExited) {
      serverProc.kill('SIGTERM');
      await setTimeout(500);
    }
  }
}

main().catch((err) => {
  console.error('[e2e] failed:', err);
  process.exit(1);
});
