import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { ProcessorClient } from '../../src/processor-client.js';
import { PaymentRepository } from '../../src/repository.js';
import { PaymentService } from '../../src/service.js';

export async function spawnOracle({ logPath, failpoint = null, markerPath = null }) {
  const child = spawn(process.execPath, ['src/main.js', 'oracle'], {
    cwd: new URL('../..', import.meta.url),
    env: {
      ...process.env,
      PROCESSOR_LOG_PATH: logPath,
      PROCESSOR_PORT: '0',
      ...(failpoint ? { ORACLE_FAILPOINT: failpoint } : {}),
      ...(markerPath ? { FAILPOINT_MARKER_PATH: markerPath } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const line = await Promise.race([
    new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline >= 0) resolve(buffer.slice(0, newline));
      });
      child.once('exit', (code) => reject(new Error(`oracle exited before ready (${code}): ${stderr}`)));
    }),
    delay(5_000).then(() => { throw new Error('oracle readiness timed out'); })
  ]);
  const ready = JSON.parse(line);
  const baseUrl = `http://127.0.0.1:${ready.port}`;
  return {
    child,
    baseUrl,
    client: new ProcessorClient(baseUrl, { timeoutMs: 5_000 }),
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      await once(child, 'exit');
    }
  };
}

export async function createRuntime(databaseUrl, processorUrl, { reset = false, timeoutMs = 2_000 } = {}) {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const repository = await new PaymentRepository(pool).init();
  if (reset) await repository.reset();
  const service = new PaymentService(repository, new ProcessorClient(processorUrl, { timeoutMs }));
  return { pool, repository, service, close: () => repository.close() };
}

export async function waitForMarker(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error('failpoint marker timed out');
}

export function fixture(suffix, amountMinor = '1000') {
  return {
    payment: {
      requestKey: `req_payment_${suffix}`,
      paymentId: `pay_payment_${suffix}`,
      merchantId: `merchant_lab_${suffix}`,
      orderId: `order_lab_${suffix}`,
      amountMinor,
      currency: 'LAB'
    },
    capture: {
      requestKey: `req_capture_${suffix}`,
      attemptId: `att_capture_${suffix}`,
      processorKey: `proc_capture_${suffix}`,
      syntheticDecision: 'accepted',
      expectedWorkerGeneration: 1
    }
  };
}

export function refundFixture(suffix, amountMinor, expectedWorkerGeneration = 1) {
  return {
    requestKey: `req_refund_${suffix}`,
    refundId: `ref_refund_${suffix}`,
    attemptId: `att_refund_${suffix}`,
    processorKey: `proc_refund_${suffix}`,
    amountMinor,
    currency: 'LAB',
    reasonClass: 'requested_by_merchant',
    syntheticDecision: 'accepted',
    expectedWorkerGeneration
  };
}
