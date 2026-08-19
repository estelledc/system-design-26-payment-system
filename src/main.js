import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { DurableProcessorOracle, createOracleServer } from './processor-oracle.js';
import { ProcessorClient } from './processor-client.js';
import { PaymentRepository } from './repository.js';
import { PaymentService } from './service.js';
import { createPaymentServer } from './http.js';

async function main() {
  const command = process.argv[2];
  if (command === 'oracle') {
    const logPath = process.env.PROCESSOR_LOG_PATH;
    if (!logPath) throw new Error('PROCESSOR_LOG_PATH is required');
    const oracle = await new DurableProcessorOracle(logPath).init();
    const server = await createOracleServer({
      oracle,
      port: Number(process.env.PROCESSOR_PORT ?? 0),
      failpoint: process.env.ORACLE_FAILPOINT ?? null,
      markerPath: process.env.FAILPOINT_MARKER_PATH ?? null
    });
    const address = server.address();
    process.stdout.write(`${JSON.stringify({ status: 'ready', port: address.port })}\n`);
    return;
  }
  if (command === 'serve') {
    if (!process.env.DATABASE_URL || !process.env.PROCESSOR_URL) {
      throw new Error('DATABASE_URL and PROCESSOR_URL are required');
    }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
    const repository = await new PaymentRepository(pool).init();
    const service = new PaymentService(repository, new ProcessorClient(process.env.PROCESSOR_URL));
    const server = await createPaymentServer(service, { port: Number(process.env.PORT ?? 3000) });
    process.stdout.write(`${JSON.stringify({ status: 'ready', port: server.address().port })}\n`);
    return;
  }
  throw new Error('usage: node src/main.js <serve|oracle>');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
