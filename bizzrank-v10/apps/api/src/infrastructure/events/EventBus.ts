import { EventEmitter } from 'events';
import type { DomainEvent } from '../../shared/types/contracts.js';
import { randomUUID } from 'crypto';
import { logger } from '../logger/Logger.js';

class EventBus extends EventEmitter {
  publish<T>(eventType: string, payload: T): void {
    const event: DomainEvent<T> = {
      eventId: randomUUID(),
      eventType,
      occurredAt: new Date().toISOString(),
      payload,
    };
    logger.debug(`[EventBus] Publishing ${eventType}`, { eventId: event.eventId });
    this.emit(eventType, event);
    this.emit('*', event); // wildcard listener for logging
  }

  subscribe<T>(eventType: string, handler: (event: DomainEvent<T>) => Promise<void>): void {
    this.on(eventType, async (event: DomainEvent<T>) => {
      try {
        await handler(event);
      } catch (err: any) {
        logger.error(`[EventBus] Handler failed for ${eventType}`, { error: err.message, eventId: event.eventId });
      }
    });
    logger.info(`[EventBus] ${eventType} — handler registered`);
  }
}

// Single instance shared across all domains
export const eventBus = new EventBus();
eventBus.setMaxListeners(50);

// Event type constants — prevents typos
export const Events = {
  SCAN_ORGANIC_STARTED:   'scan.organic.started',
  SCAN_ORGANIC_PROGRESS:  'scan.organic.progress',
  SCAN_ORGANIC_COMPLETED: 'scan.organic.completed',
  SCAN_ORGANIC_FAILED:    'scan.organic.failed',
  SCAN_AD_SLOT_COMPLETED: 'scan.ad.slot.completed',
  REVIEW_FETCHED:         'review.fetched',
  LEADERBOARD_COMPUTED:   'leaderboard.computed',
  CREDITS_DEDUCTED:       'billing.credits.deducted',
  // Fired by GBPGuardService when critical/warning fields change.
  // AICitationService subscribes to trigger a citation re-check
  // when website, address, name, or phone changes are detected.
  GBP_CHANGE_DETECTED:    'gbp.change.detected',
} as const;
