import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { ProcessorClient } from '../src/processor-client.js';
import { PaymentRepository } from '../src/repository.js';
import { PaymentService } from '../src/service.js';

async function stopAtMarker() {
  const markerPath = process.env.FAILPOINT_MARKER_PATH;
  await mkdir(dirname(markerPath), { recursive: true });
  const handle = await open(markerPath, 'w', 0o600);
  try {
    await handle.writeFile('committed\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await new Promise(() => {});
}

async function main() {
  const operation = process.argv[2];
  const payload = JSON.parse(process.env.CRASH_PAYLOAD);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const repository = await new PaymentRepository(pool).init();
  const service = new PaymentService(repository, new ProcessorClient(process.env.PROCESSOR_URL, { timeoutMs: 5_000 }));

  if (operation === 'create-payment-after-commit') {
    await service.createPayment(payload.payment, { afterCommit: stopAtMarker });
  } else if (operation === 'prepare-capture-after-commit') {
    await service.prepareCapture(payload.paymentId, payload.capture, { afterCommit: stopAtMarker });
  } else if (operation === 'capture-after-external') {
    await service.dispatchAttempt(payload.attemptId, { afterExternalResult: stopAtMarker });
  } else if (operation === 'capture-after-commit') {
    await service.dispatchAttempt(payload.attemptId, { afterCommit: stopAtMarker });
  } else if (operation === 'refund-after-external') {
    await service.dispatchAttempt(payload.attemptId, { afterExternalResult: stopAtMarker });
  } else if (operation === 'refund-after-commit') {
    await service.dispatchAttempt(payload.attemptId, { afterCommit: stopAtMarker });
  } else if (operation === 'delivery-after-commit') {
    await service.acknowledgeDelivery(payload.deliveryId, payload.delivery, { afterCommit: stopAtMarker });
  } else if (operation === 'reconcile-after-commit') {
    await service.reconcileAttempt(payload.attemptId, {
      expectedWorkerGeneration: payload.expectedWorkerGeneration,
      afterCommit: stopAtMarker
    });
  } else {
    throw new Error('unsupported crash operation');
  }
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
