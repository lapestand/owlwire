import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { loadAuthEnv } from '../config/auth-env.js';
import {
  createMailerFromEnv,
  createMemoryMailer,
  createSmtpMailer,
  MailMessageError,
  MEMORY_OUTBOX_LIMIT,
  SMTP_TIMEOUTS_MS,
  smtpTransportOptions,
  type TransportFactory,
} from './mailer.js';

const SECRET = 'fixture-secret-for-mailer-tests-0123';
const msg = { to: 'b@x.test', subject: 'hello', text: 'body', html: '<p>body</p>' };

function recordingFactory() {
  const calls: { url: string; sent: unknown[] } = { url: '', sent: [] };
  const factory: TransportFactory = (url) => {
    calls.url = url;
    return { sendMail: async (opts: unknown) => void calls.sent.push(opts) };
  };
  return { calls, factory };
}

describe('mailer', () => {
  it('memory mailer stores messages', async () => {
    const m = createMemoryMailer();
    await m.send({ to: 'a@x.test', subject: 's', text: 't', html: '<p>t</p>' });
    expect(m.outbox).toEqual([{ to: 'a@x.test', subject: 's', text: 't', html: '<p>t</p>' }]);
  });

  it('memory mailer keeps a copy, not the caller object', async () => {
    const m = createMemoryMailer();
    const own = { ...msg };
    await m.send(own);
    own.subject = 'changed';
    expect(m.outbox[0]?.subject).toBe('hello');
  });

  it('memory mailer keeps only the newest messages', async () => {
    const m = createMemoryMailer();
    for (let i = 0; i < MEMORY_OUTBOX_LIMIT + 5; i++) await m.send({ ...msg, subject: `s${i}` });
    expect(m.outbox).toHaveLength(MEMORY_OUTBOX_LIMIT);
    expect(m.outbox[0]?.subject).toBe('s5');
    expect(m.outbox.at(-1)?.subject).toBe(`s${MEMORY_OUTBOX_LIMIT + 4}`);
  });

  it('smtp mailer passes from and message to the transport', async () => {
    const sent: unknown[] = [];
    let usedUrl = '';
    const mailer = createSmtpMailer('smtp://u:p@mail:587', 'Owlwire <no-reply@x.test>', (url) => {
      usedUrl = url;
      return { sendMail: async (opts: unknown) => void sent.push(opts) };
    });
    await mailer.send({ to: 'b@x.test', subject: 'hello', text: 'body', html: '<p>body</p>' });
    expect(usedUrl).toBe('smtp://u:p@mail:587');
    expect(sent).toEqual([
      {
        from: 'Owlwire <no-reply@x.test>',
        to: 'b@x.test',
        subject: 'hello',
        text: 'body',
        html: '<p>body</p>',
      },
    ]);
  });

  it('smtp mailer rejects when the transport fails', async () => {
    const mailer = createSmtpMailer('smtp://mail:25', 'no-reply@x.test', () => ({
      sendMail: async () => {
        throw new Error('connection refused');
      },
    }));
    await expect(mailer.send(msg)).rejects.toThrow('connection refused');
  });

  it.each([
    'a@x.test, victim@y.test',
    'a@x.test,victim@y.test',
    'a@x.test; victim@y.test',
    'Eve <a@x.test>',
    '<a@x.test>',
    'a@x.test\r\nBcc: victim@y.test',
    'a@x.test\n',
    ' a@x.test',
    'a b@x.test',
    '"a"@x.test',
    'a@x.test:25',
    'no-at-sign',
    '@x.test',
    'a@',
    'a@b@x.test',
    '',
    `${'a'.repeat(250)}@x.test`,
  ])('refuses the recipient %j and sends nothing', async (to) => {
    const { calls, factory } = recordingFactory();
    const smtp = createSmtpMailer('smtp://mail:25', 'no-reply@x.test', factory);
    await expect(smtp.send({ ...msg, to })).rejects.toThrow(MailMessageError);
    expect(calls.sent).toEqual([]);
    const memory = createMemoryMailer();
    await expect(memory.send({ ...msg, to })).rejects.toThrow(MailMessageError);
    expect(memory.outbox).toEqual([]);
  });

  it.each(['ayşe@örnek.test', 'first.last+tag@sub.x.test'])(
    'accepts the recipient %j',
    async (to) => {
      const { calls, factory } = recordingFactory();
      await createSmtpMailer('smtp://mail:25', 'no-reply@x.test', factory).send({ ...msg, to });
      expect(calls.sent).toHaveLength(1);
    },
  );

  it.each(['', '   ', 'a\r\nBcc: v@y.test', 'a\nb', 'a\u2028b', 'a\u202Eb'])(
    'refuses the subject %j and sends nothing',
    async (subject) => {
      const { calls, factory } = recordingFactory();
      const smtp = createSmtpMailer('smtp://mail:25', 'no-reply@x.test', factory);
      await expect(smtp.send({ ...msg, subject })).rejects.toThrow(MailMessageError);
      expect(calls.sent).toEqual([]);
    },
  );

  it('does not put the recipient in the error message', async () => {
    const m = createMemoryMailer();
    await expect(m.send({ ...msg, to: 'secret@x.test, other@y.test' })).rejects.toThrow(
      /^mail recipient must be exactly one plain email address$/,
    );
  });

  it('gives the SMTP transport short timeouts', () => {
    expect(smtpTransportOptions('smtp://mail:25')).toEqual({
      url: 'smtp://mail:25',
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    // nodemailer keeps the timeouts next to what it parsed from the URL; building a transport opens no connection.
    const transport = nodemailer.createTransport(smtpTransportOptions('smtp://u:p@mail:587'));
    const options = transport.options as Record<string, unknown>;
    expect(options).toMatchObject({ host: 'mail', port: 587, ...SMTP_TIMEOUTS_MS });
  });

  it('returns null without smtp settings', () => {
    expect(createMailerFromEnv(loadAuthEnv({ OWLWIRE_AUTH_SECRET: SECRET }))).toBeNull();
  });

  it('returns a mailer with smtp settings', () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_SMTP_URL: 'smtp://mail:25',
      OWLWIRE_SMTP_FROM: 'no-reply@x.test',
    });
    expect(createMailerFromEnv(env)).not.toBeNull();
  });

  it('hands the configured smtp url and from address to the transport', async () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_SMTP_URL: 'smtps://user:pass@mail.x.test:465',
      OWLWIRE_SMTP_FROM: 'Owlwire <no-reply@x.test>',
    });
    const { calls, factory } = recordingFactory();
    const mailer = createMailerFromEnv(env, factory);
    await mailer?.send(msg);
    expect(calls.url).toBe('smtps://user:pass@mail.x.test:465');
    expect(calls.sent).toEqual([{ from: 'Owlwire <no-reply@x.test>', ...msg }]);
  });
});
