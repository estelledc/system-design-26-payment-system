import { DomainError, fail } from './errors.js';

async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (response.status === 404) return null;
    if (response.status === 409) fail('intent_conflict', 'processor rejected changed intent', 409);
    if (!response.ok || !body) fail('dependency_unavailable', 'processor returned unusable evidence', 503);
    return body;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail('external_unknown', 'processor response is absent or ambiguous', 503);
  } finally {
    clearTimeout(timer);
  }
}

export class ProcessorClient {
  constructor(baseUrl, { timeoutMs = 2_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  dispatch(request) {
    return requestJson(`${this.baseUrl}/v1/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request)
    }, this.timeoutMs);
  }

  query(processorKey) {
    return requestJson(
      `${this.baseUrl}/v1/operations/${encodeURIComponent(processorKey)}`,
      { method: 'GET' },
      this.timeoutMs
    );
  }
}
