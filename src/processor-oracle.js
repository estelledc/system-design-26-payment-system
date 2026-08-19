import { open, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import { canonicalJson, digest, LIMITS, parseId, parseProcessorRequest } from './contracts.js';
import { DomainError, asDomainError, fail } from './errors.js';

async function durableMarker(path) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w', 0o600);
  try {
    await handle.writeFile('durable\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > LIMITS.bodyBytes) fail('invalid_request', 'request body exceeds bound', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) fail('invalid_request', 'request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('invalid_request', 'request body must be valid JSON');
  }
}

function send(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded)
  });
  response.end(encoded);
}

export class DurableProcessorOracle {
  constructor(logPath) {
    this.logPath = logPath;
    this.records = new Map();
    this.tail = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.logPath), { recursive: true });
    let raw;
    try {
      raw = await readFile(this.logPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(this.logPath, '', { mode: 0o600 });
      raw = '';
    }
    if (raw.length > 0 && !raw.endsWith('\n')) {
      throw new Error('processor log has a truncated final record');
    }
    for (const line of raw.split('\n').filter(Boolean)) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error('processor log contains malformed JSON');
      }
      const parsed = parseProcessorRequest(record.request);
      const expectedReceipt = digest({ request: parsed, decision: parsed.decision });
      if (record.receiptDigest !== expectedReceipt) throw new Error('processor log receipt digest mismatch');
      const existing = this.records.get(parsed.processorKey);
      if (existing && canonicalJson(existing.request) !== canonicalJson(parsed)) {
        throw new Error('processor log rebinds one key to changed intent');
      }
      this.records.set(parsed.processorKey, Object.freeze({ request: parsed, receiptDigest: expectedReceipt }));
    }
    return this;
  }

  async decide(input) {
    const request = parseProcessorRequest(input);
    const run = async () => {
      const existing = this.records.get(request.processorKey);
      if (existing) {
        if (canonicalJson(existing.request) !== canonicalJson(request)) {
          fail('intent_conflict', 'processor key is already bound to changed intent', 409);
        }
        return this.toResult(existing);
      }
      const record = Object.freeze({
        request,
        receiptDigest: digest({ request, decision: request.decision })
      });
      const handle = await open(this.logPath, 'a', 0o600);
      try {
        await handle.writeFile(`${canonicalJson(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.records.set(request.processorKey, record);
      return this.toResult(record);
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  get(processorKey) {
    const record = this.records.get(processorKey);
    return record ? this.toResult(record) : null;
  }

  toResult(record) {
    return Object.freeze({
      processorKey: record.request.processorKey,
      requestDigest: record.request.requestDigest,
      kind: record.request.kind,
      aggregateId: record.request.aggregateId,
      paymentId: record.request.paymentId,
      amountMinor: record.request.amountMinor,
      currency: record.request.currency,
      decision: record.request.decision,
      receiptDigest: record.receiptDigest,
      durable: true,
      realMoneyMoved: false,
      externalAcceptance: false
    });
  }
}

export async function createOracleServer({ oracle, host = '127.0.0.1', port = 0, failpoint = null, markerPath = null }) {
  let failpointUsed = false;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://oracle.invalid');
      if (request.method === 'GET' && url.pathname === '/health') {
        return send(response, 200, { status: 'ok', durableRecords: oracle.records.size });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/operations/')) {
        const key = parseId(decodeURIComponent(url.pathname.slice('/v1/operations/'.length)), 'processorKey');
        const result = oracle.get(key);
        return result ? send(response, 200, result) : send(response, 404, { code: 'not_found' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/operations') {
        const result = await oracle.decide(await readBody(request));
        if (failpoint === 'after_fsync_once' && !failpointUsed) {
          failpointUsed = true;
          await durableMarker(markerPath);
          await new Promise(() => {});
        }
        return send(response, 200, result);
      }
      return send(response, 404, { code: 'not_found' });
    } catch (error) {
      const mapped = error instanceof DomainError ? error : asDomainError(error);
      return send(response, mapped.status, { code: mapped.code, message: mapped.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
