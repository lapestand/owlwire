import type {
  AdapterFactory,
  Capabilities,
  ConnectionRef,
  Health,
  SendOutcome,
} from '@owlwire/adapter-sdk';
import { Api, GrammyError } from 'grammy';
import { mapTelegramError } from './errors.js';
import { withNativeAbortSignal } from './fetch.js';
import { renderTelegramHtml, TELEGRAM_MAX_TEXT } from './render.js';

/** Contents of connections.config_enc for platform = telegram, kind = own_bot. */
export interface TelegramOwnBotConfig {
  botToken: string;
}

export const TELEGRAM_CAPABILITIES: Capabilities = {
  formatting: 'telegram_html',
  maxBodyLength: TELEGRAM_MAX_TEXT,
  images: false,
  typingIndicator: false,
  dm: true,
  threads: true,
};

function ownBotToken(conn: ConnectionRef): string | null {
  if (conn.kind !== 'own_bot') return null;
  const token = conn.config.botToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export const createTelegramAdapter: AdapterFactory = (deps, instanceConfig) => {
  const apiRoot = typeof instanceConfig.apiRoot === 'string' ? instanceConfig.apiRoot : undefined;
  const timeoutSeconds =
    typeof instanceConfig.timeoutSeconds === 'number' && instanceConfig.timeoutSeconds > 0
      ? instanceConfig.timeoutSeconds
      : 30;
  // grammY hands fetch a polyfilled AbortSignal that Node's native fetch rejects.
  const fetchFn = withNativeAbortSignal(deps.fetch);
  const apiFor = (token: string) =>
    new Api(token, { fetch: fetchFn, timeoutSeconds, ...(apiRoot ? { apiRoot } : {}) });

  async function check(conn: ConnectionRef): Promise<Health> {
    const token = ownBotToken(conn);
    // Health.reason is a machine key; raw errors go to the log only.
    if (!token) return { status: 'broken', reason: 'telegram.status.missingBotToken' };
    try {
      await apiFor(token).getMe();
      return { status: 'active' };
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 401) {
        return { status: 'broken', reason: 'telegram.status.invalidBotToken' };
      }
      deps.logger.warn(
        { connectionId: conn.id, err: err instanceof Error ? err.message : String(err) },
        'telegram health check failed',
      );
      return { status: 'degraded', reason: 'telegram.status.unreachable' };
    }
  }

  return {
    platform: 'telegram',
    capabilities: () => TELEGRAM_CAPABILITIES,
    validateConnection: check,
    health: check,
    discoverDestinations: async () => [],
    render: (msg, _dest, caps) => renderTelegramHtml(msg, caps.maxBodyLength),
    async send(conn, dest, rendered): Promise<SendOutcome> {
      if (conn.kind === 'shared_bot') {
        return {
          status: 'permanent',
          error: 'shared telegram bot is not supported yet',
          destinationBroken: false,
        };
      }
      const token = ownBotToken(conn);
      if (!token) {
        return {
          status: 'permanent',
          error: 'connection has no bot token',
          destinationBroken: false,
        };
      }
      const threadId = dest.externalSubId !== null ? Number(dest.externalSubId) : Number.NaN;
      try {
        const sent = await apiFor(token).sendMessage(dest.externalId, rendered.text, {
          ...(rendered.parseMode ? { parse_mode: rendered.parseMode } : {}),
          ...(Number.isInteger(threadId) ? { message_thread_id: threadId } : {}),
          link_preview_options: { is_disabled: true },
        });
        return { status: 'ok', platformMessageId: String(sent.message_id) };
      } catch (err) {
        const outcome = mapTelegramError(err);
        deps.logger.warn(
          { connectionId: conn.id, outcome: outcome.status },
          'telegram send failed',
        );
        return outcome;
      }
    },
    platformLimits: () => ({
      global: { capacity: 30, refillPerSec: 30 },
      perDestination: { capacity: 20, refillPerSec: 20 / 60 },
    }),
  };
};
