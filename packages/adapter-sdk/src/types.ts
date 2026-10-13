import type { Message } from '@owlwire/core/message';

export type Platform = 'telegram' | 'discord' | 'whatsapp' | 'webhook';
export type ConnectionKind = 'shared_bot' | 'own_bot' | 'webhook' | 'number';
export type DestinationKind =
  | 'group'
  | 'community'
  | 'dm'
  | 'channel'
  | 'topic'
  | 'thread'
  | 'forum_post'
  | 'webhook';

export interface ConnectionRef {
  id: string;
  workspaceId: string;
  platform: Platform;
  kind: ConnectionKind;
  /** Decrypted configuration; {} for shared bots (the adapter uses instance settings). */
  config: Record<string, unknown>;
}

export interface DestinationRef {
  id: string;
  kind: DestinationKind;
  externalId: string;
  externalSubId: string | null;
  name: string;
}

export interface Capabilities {
  formatting: 'telegram_html' | 'discord_markdown' | 'whatsapp' | 'plain';
  maxBodyLength: number;
  images: boolean;
  typingIndicator: boolean;
  dm: boolean;
  threads: boolean;
}

export interface RenderedMessage {
  text: string;
  parseMode?: 'HTML';
  embeds?: unknown[];
  imageUrl?: string;
  truncated: boolean;
}

export interface SendOptions {
  typingMs?: number;
}

export type SendOutcome =
  | { status: 'ok'; platformMessageId?: string }
  | { status: 'transient'; error: string; retryAfterMs?: number }
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'permanent'; error: string; destinationBroken: boolean }
  | { status: 'banned'; error: string };

export interface Health {
  status: 'active' | 'degraded' | 'broken';
  reason?: string;
}

export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

export interface LimitPolicy {
  global?: BucketSpec;
  perConnection?: BucketSpec;
  perDestination?: BucketSpec;
}

export interface DiscoveredDestination {
  kind: DestinationKind;
  externalId: string;
  externalSubId: string | null;
  name: string;
}

export type InboundEvent =
  | {
      type: 'consent_code';
      connectionId: string;
      code: string;
      destination: DiscoveredDestination;
      actorExternalId?: string;
    }
  | { type: 'added_to_chat'; connectionId: string; destination: DiscoveredDestination }
  | {
      type: 'removed_from_chat';
      connectionId: string;
      externalId: string;
      externalSubId: string | null;
    }
  | { type: 'connection_state'; connectionId: string; health: Health }
  | { type: 'ban_signal'; connectionId: string; error: string };

/** P0 subset of contract §8; P1d widens the result to Promise<InboundResult | void> (R3). */
export interface InboundSink {
  emit(ev: InboundEvent): Promise<void>;
}

export type Fn = (objOrMsg: unknown, msg?: string) => void;

export interface AdapterDeps {
  logger: { info: Fn; warn: Fn; error: Fn; debug: Fn };
  fetch: typeof fetch;
  clock: { now(): Date };
}

export interface ChannelAdapter {
  readonly platform: Platform;
  capabilities(conn: ConnectionRef): Capabilities;
  validateConnection(conn: ConnectionRef): Promise<Health>;
  discoverDestinations(conn: ConnectionRef): Promise<DiscoveredDestination[]>;
  render(msg: Message, dest: DestinationRef, caps: Capabilities): RenderedMessage;
  send(
    conn: ConnectionRef,
    dest: DestinationRef,
    rendered: RenderedMessage,
    opts: SendOptions,
  ): Promise<SendOutcome>;
  health(conn: ConnectionRef): Promise<Health>;
  platformLimits(conn: ConnectionRef): LimitPolicy;
  /** Long-running listeners (TG polling, DC gateway). Only called in the worker role. */
  start?(sink: InboundSink, conns: () => Promise<ConnectionRef[]>): Promise<void>;
  stop?(): Promise<void>;
  /** Platform events received over HTTP (TG webhook mode, Evolution webhook). P1e also allows a Promise. */
  parseWebhook?(
    conn: ConnectionRef,
    headers: Record<string, string>,
    body: unknown,
  ): InboundEvent[];
}

export type AdapterFactory = (
  deps: AdapterDeps,
  instanceConfig: Record<string, unknown>,
) => ChannelAdapter;
