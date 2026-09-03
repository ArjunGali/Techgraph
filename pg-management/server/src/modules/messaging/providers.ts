import { env } from '../../config/env.js';

/**
 * Messaging provider adapters.
 *
 * The application only ever talks to this interface, so moving from the local
 * stub to an official WhatsApp Business provider is a configuration change and
 * a new adapter — no calling code changes, and the message history stays
 * intact and attributable across the switch.
 */
export type OutboundMessage = {
  to: string;
  body: string;
  /** Absolute URL of an image to attach, such as a payment QR. */
  mediaUrl?: string | null;
};

export type SendResult = {
  status: 'sent' | 'failed';
  providerMessageId?: string | null;
  error?: string | null;
};

export interface MessageProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * Local development provider. Records the message and reports success without
 * contacting anyone, so billing runs and reminder ladders can be exercised
 * safely.
 */
class StubProvider implements MessageProvider {
  readonly name = 'stub';

  async send(message: OutboundMessage): Promise<SendResult> {
    console.log(`[whatsapp:stub] -> ${message.to}\n${message.body}\n`);
    return { status: 'sent', providerMessageId: `stub-${Date.now()}` };
  }
}

/**
 * WhatsApp Business Cloud API.
 *
 * Uses the official Graph endpoint, so templates, opt-in and delivery receipts
 * behave as the platform intends rather than through an unofficial bridge.
 */
class WhatsAppCloudProvider implements MessageProvider {
  readonly name = 'whatsapp_cloud';

  async send(message: OutboundMessage): Promise<SendResult> {
    const baseUrl = env.WHATSAPP_API_URL ?? 'https://graph.facebook.com/v21.0';
    const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
    const token = env.WHATSAPP_API_TOKEN;

    if (!phoneNumberId || !token) {
      return {
        status: 'failed',
        error: 'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_API_TOKEN must be set for this provider',
      };
    }

    try {
      const response = await fetch(`${baseUrl}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: message.to,
          type: 'text',
          text: { body: message.body },
        }),
      });

      if (!response.ok) {
        return { status: 'failed', error: `${response.status}: ${await response.text()}` };
      }

      const payload = (await response.json()) as { messages?: { id?: string }[] };
      return { status: 'sent', providerMessageId: payload.messages?.[0]?.id ?? null };
    } catch (error) {
      return { status: 'failed', error: (error as Error).message };
    }
  }
}

const providers = new Map<string, MessageProvider>([
  ['stub', new StubProvider()],
  ['whatsapp_cloud', new WhatsAppCloudProvider()],
]);

export function getMessageProvider(name = env.WHATSAPP_PROVIDER): MessageProvider {
  return providers.get(name) ?? providers.get('stub')!;
}

/** Fills `{{placeholders}}` in a template body. */
export function renderTemplate(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => variables[key] ?? match);
}
