export class DomainError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function fail(code, message, status = 400, details = undefined) {
  throw new DomainError(code, message, status, details);
}

export function asDomainError(error) {
  if (error instanceof DomainError) return error;
  return new DomainError('dependency_unavailable', 'required dependency did not provide a usable result', 503);
}
