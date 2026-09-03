import type { Db } from '../../db/pool.js';
import { formatPaise } from '../../calc/index.js';
import { getMessageProvider, renderTemplate } from './providers.js';
import { AUDIT, writeAudit } from '../../lib/audit.js';

/**
 * Composes and sends tenant-facing messages.
 *
 * Every send is written to `whatsapp_messages` before and after the provider
 * call, so a failure is visible and retryable rather than silently lost.
 * Identity documents are never attached to a message — only billing figures
 * and the payment QR.
 */

export type BillMessageContext = {
  tenantName: string;
  periodMonth: string;
  rentPaise: number;
  ebPaise: number;
  commonChargePaise: number;
  otherChargesPaise: number;
  previousDuesPaise: number;
  totalPaise: number;
  outstandingPaise: number;
  paymentIdentifier?: string | null;
  breakdown?: string[];
};

const DEFAULT_BILL_TEMPLATE = `Hello {{tenantName}},

Your bill for {{periodMonth}}:
Rent: {{rent}}
Electricity: {{eb}}
Common charge: {{commonCharge}}{{otherLine}}{{previousDuesLine}}
Total payable: {{total}}

{{paymentLine}}

Please share the payment screenshot once paid. Thank you.`;

export function buildBillMessage(
  context: BillMessageContext,
  templateBody = DEFAULT_BILL_TEMPLATE,
): string {
  return renderTemplate(templateBody, {
    tenantName: context.tenantName,
    periodMonth: context.periodMonth.slice(0, 7),
    rent: formatPaise(context.rentPaise),
    eb: formatPaise(context.ebPaise),
    commonCharge: formatPaise(context.commonChargePaise),
    otherLine:
      context.otherChargesPaise > 0
        ? `\nOther charges: ${formatPaise(context.otherChargesPaise)}`
        : '',
    previousDuesLine:
      context.previousDuesPaise !== 0
        ? `\nPrevious dues: ${formatPaise(context.previousDuesPaise)}`
        : '',
    total: formatPaise(context.totalPaise),
    outstanding: formatPaise(context.outstandingPaise),
    paymentLine: context.paymentIdentifier
      ? `Pay to: ${context.paymentIdentifier}`
      : 'Payment details are attached.',
  });
}

export type QueuedMessage = {
  tenantId: string | null;
  billId: string | null;
  branchId: string | null;
  phone: string;
  body: string;
  templateCode?: string | null;
  mediaStorageKey?: string | null;
};

/** Queues a message, attempts delivery, and records the outcome either way. */
export async function sendMessage(
  db: Db,
  message: QueuedMessage,
  context: { userId: string | null },
): Promise<{ id: string; status: string; error: string | null }> {
  const provider = getMessageProvider();

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO whatsapp_messages
       (tenant_id, bill_id, branch_id, template_code, phone, body, media_storage_key,
        provider, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9)
     RETURNING id`,
    [
      message.tenantId, message.billId, message.branchId, message.templateCode ?? null,
      message.phone, message.body, message.mediaStorageKey ?? null, provider.name, context.userId,
    ],
  );
  const messageId = rows[0]!.id;

  const result = await provider.send({ to: message.phone, body: message.body });

  await db.query(
    `UPDATE whatsapp_messages
        SET status = $2, provider_message_id = $3, error = $4,
            attempts = attempts + 1,
            sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
            updated_at = now()
      WHERE id = $1`,
    [messageId, result.status, result.providerMessageId ?? null, result.error ?? null],
  );

  if (result.status === 'sent') {
    await writeAudit(db, {
      userId: context.userId,
      action: AUDIT.MESSAGE_SENT,
      entityType: 'whatsapp_message',
      entityId: messageId,
      branchId: message.branchId,
      meta: { phone: message.phone, billId: message.billId, provider: provider.name },
    });
  }

  return { id: messageId, status: result.status, error: result.error ?? null };
}

/**
 * Retries messages that failed, up to a bounded number of attempts, so a
 * provider outage does not need manual re-sending of every bill.
 */
export async function retryFailedMessages(db: Db, maxAttempts = 3): Promise<number> {
  const { rows } = await db.query<{
    id: string; phone: string; body: string; branch_id: string | null;
  }>(
    `SELECT id, phone, body, branch_id FROM whatsapp_messages
      WHERE status = 'failed' AND attempts < $1
      ORDER BY created_at LIMIT 100`,
    [maxAttempts],
  );

  const provider = getMessageProvider();
  let sent = 0;

  for (const message of rows) {
    const result = await provider.send({ to: message.phone, body: message.body });
    await db.query(
      `UPDATE whatsapp_messages
          SET status = $2, provider_message_id = $3, error = $4, attempts = attempts + 1,
              sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END, updated_at = now()
        WHERE id = $1`,
      [message.id, result.status, result.providerMessageId ?? null, result.error ?? null],
    );
    if (result.status === 'sent') sent += 1;
  }

  return sent;
}
