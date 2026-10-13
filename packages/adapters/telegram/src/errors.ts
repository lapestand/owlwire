import type { SendOutcome } from '@owlwire/adapter-sdk';
import { GrammyError, HttpError } from 'grammy';

const DESTINATION_GONE =
  /chat not found|bot was kicked|bot was blocked|not a member|have no rights|not enough rights|CHAT_WRITE_FORBIDDEN|message thread not found|TOPIC_CLOSED|user is deactivated/i;

export function mapTelegramError(err: unknown): SendOutcome {
  if (err instanceof GrammyError) {
    const code = err.error_code;
    const error = `telegram ${code}: ${err.description}`;
    if (code === 429) {
      return { status: 'rate_limited', retryAfterMs: (err.parameters.retry_after ?? 1) * 1000 };
    }
    if (code >= 500) return { status: 'transient', error };
    if (code === 401 || code === 404)
      return { status: 'permanent', error, destinationBroken: false };
    if (code === 403 || DESTINATION_GONE.test(err.description)) {
      return { status: 'permanent', error, destinationBroken: true };
    }
    return { status: 'permanent', error, destinationBroken: false };
  }
  if (err instanceof HttpError) return { status: 'transient', error: `network: ${err.message}` };
  return { status: 'transient', error: err instanceof Error ? err.message : String(err) };
}
