import { describe, expect, it } from 'vitest';
import { loadAuthEnv } from '../config/auth-env.js';
import { createMailerFromEnv, createMemoryMailer, createSmtpMailer } from './mailer.js';

const SECRET = 'fixture-secret-for-mailer-tests-0123';

describe('mailer', () => {
  it('memory mailer stores messages', async () => {
    const m = createMemoryMailer();
    await m.send({ to: 'a@x.test', subject: 's', text: 't', html: '<p>t</p>' });
    expect(m.outbox).toEqual([{ to: 'a@x.test', subject: 's', text: 't', html: '<p>t</p>' }]);
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
  it('memory mailer keeps a copy, not the caller object', async () => {
    const m = createMemoryMailer();
    const msg = { to: 'a@x.test', subject: 's', text: 't', html: 'h' };
    await m.send(msg);
    msg.subject = 'changed';
    expect(m.outbox[0]?.subject).toBe('s');
  });

  it('smtp mailer rejects when the transport fails', async () => {
    const mailer = createSmtpMailer('smtp://mail:25', 'no-reply@x.test', () => ({
      sendMail: async () => {
        throw new Error('connection refused');
      },
    }));
    await expect(
      mailer.send({ to: 'b@x.test', subject: 's', text: 't', html: 'h' }),
    ).rejects.toThrow('connection refused');
  });
});
