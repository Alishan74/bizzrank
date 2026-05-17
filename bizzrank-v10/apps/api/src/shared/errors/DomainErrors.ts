// ============================================================
// BizzRank AI v10 — Typed Domain Errors
// ============================================================

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InsufficientCreditsError extends DomainError {
  constructor(required: number, available: number) {
    super('INSUFFICIENT_CREDITS', `This action requires ${required} credits. You have ${available} credits.`, 402);
  }
}

export class BusinessLimitError extends DomainError {
  constructor(limit: number, plan: string) {
    super('BUSINESS_LIMIT', `Your ${plan} plan allows ${limit} business${limit === 1 ? '' : 'es'}. Upgrade to add more.`, 403);
  }
}

export class CompetitorLimitError extends DomainError {
  constructor(limit: number, plan: string) {
    super('COMPETITOR_LIMIT', `Your ${plan} plan allows ${limit} competitors per business.`, 403);
  }
}

export class BusinessNotFoundError extends DomainError {
  constructor() {
    super('BUSINESS_NOT_FOUND', 'Business not found.', 404);
  }
}

export class ScanNotFoundError extends DomainError {
  constructor() {
    super('SCAN_NOT_FOUND', 'Scan not found.', 404);
  }
}

export class NoScanPointsError extends DomainError {
  constructor() {
    super('NO_SCAN_POINTS', 'Could not generate scan points. Check business location is set correctly.', 400);
  }
}

export class NoLocationError extends DomainError {
  constructor() {
    super('NO_LOCATION', 'This business has no location set. Re-add using Google Maps search.', 400);
  }
}

export class GBPNotConnectedError extends DomainError {
  constructor() {
    super('GBP_NOT_CONNECTED', 'Google Business Profile not connected.', 400);
  }
}

export class UnauthorizedError extends DomainError {
  constructor() {
    super('UNAUTHORIZED', 'Session expired — please sign in again.', 401);
  }
}

export class RateLimitError extends DomainError {
  constructor(limit: number) {
    super('RATE_LIMIT', `You have too many active scans. Maximum ${limit} concurrent scans allowed.`, 429);
  }
}
