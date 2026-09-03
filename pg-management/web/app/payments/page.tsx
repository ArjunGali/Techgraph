'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Loading,
  SectionHeading, TextArea, TextInput, cx, type Column,
} from '@/components/ui';
import { useApiQuery, useApiMutation } from '@/lib/useApi';
import { useLayoutShape } from '@/lib/useMediaQuery';
import { fetchFileObjectUrl } from '@/lib/api';
import { formatDate, formatPaise } from '@/lib/format';
import { useAuth, P } from '@/lib/auth';

type Proof = {
  id: string; originalName: string; mimeType: string; ocrStatus: string;
  ocrAmountPaise: number | null; ocrReference: string | null; ocrProvider: string | null;
};

type Payment = {
  id: string; tenant_name: string; tenant_code: string; tenant_phone: string;
  branch_name: string; amount_paise: number; approved_amount_paise: number | null;
  method: string; reference: string | null; state: string; created_at: string;
  kind: string; period_month: string | null; bill_total_paise: number | null;
  bill_outstanding_paise: number | null; proofs?: Proof[]; proof_count?: number;
};

/**
 * The payment approval queue.
 *
 * A submitted payment — screenshot and all — changes no balance until it is
 * approved here. That is the whole point of the screen: the owner decides what
 * counts as received, and the ledger follows that decision.
 */
export default function PaymentsPage() {
  const { can } = useAuth();
  const { isTablet } = useLayoutShape();
  const [selected, setSelected] = useState<Payment | null>(null);

  const pending = useApiQuery<{ payments: Payment[] }>(
    can(P.PAYMENT_APPROVE) ? '/api/payments/pending' : null,
  );
  const history = useApiQuery<{ payments: Payment[] }>('/api/payments', { state: 'approved' });

  const columns: Column<Payment>[] = [
    {
      key: 'tenant',
      header: 'Tenant',
      primary: true,
      render: (row) => (
        <div className="min-w-0">
          <span className="block truncate font-medium">{row.tenant_name}</span>
          <span className="block truncate text-xs text-content-muted">{row.branch_name}</span>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) => (
        <span className="font-medium">
          {formatPaise(row.approved_amount_paise ?? row.amount_paise)}
        </span>
      ),
    },
    { key: 'method', header: 'Method', render: (row) => row.method },
    {
      key: 'reference',
      header: 'Reference',
      wideOnly: true,
      render: (row) => row.reference ?? '—',
    },
    { key: 'date', header: 'Submitted', render: (row) => formatDate(row.created_at) },
    {
      key: 'state',
      header: 'State',
      render: (row) => (
        <Badge
          tone={
            row.state === 'approved'
              ? 'positive'
              : row.state === 'rejected'
                ? 'critical'
                : row.state === 'reversed'
                  ? 'neutral'
                  : 'caution'
          }
        >
          {row.state.replace(/_/g, ' ')}
        </Badge>
      ),
    },
  ];

  const refresh = () => {
    pending.reload();
    history.reload();
  };

  const queue = (
    <section>
      <SectionHeading
        title="Awaiting approval"
        subtitle={
          pending.data
            ? `${pending.data.payments.length} submission(s) — nothing is credited until approved`
            : undefined
        }
      />
      {pending.loading ? <Loading /> : null}
      {pending.error ? <ErrorState message={pending.error.message} onRetry={pending.reload} /> : null}
      {pending.data ? (
        pending.data.payments.length === 0 ? (
          <EmptyState title="Nothing waiting" message="Every submitted payment has been reviewed." />
        ) : (
          <ul className="space-y-2">
            {pending.data.payments.map((payment) => (
              <li key={payment.id}>
                <button
                  onClick={() => setSelected(payment)}
                  className={cx(
                    'w-full rounded-xl border p-3 text-left transition sm:p-4',
                    selected?.id === payment.id
                      ? 'border-brand bg-brand/5'
                      : 'border-border bg-surface-raised hover:bg-surface-sunken',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{payment.tenant_name}</p>
                      <p className="truncate text-sm text-content-muted">
                        {payment.method} · {payment.reference ?? 'no reference'}
                      </p>
                    </div>
                    <p className="shrink-0 font-semibold tabular-nums">
                      {formatPaise(payment.amount_paise)}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-content-muted">
                    <span>{formatDate(payment.created_at)}</span>
                    {payment.bill_outstanding_paise !== null ? (
                      <span>· bill due {formatPaise(payment.bill_outstanding_paise)}</span>
                    ) : null}
                    {payment.proofs && payment.proofs.length > 0 ? (
                      <Badge tone="brand">{payment.proofs.length} proof</Badge>
                    ) : (
                      <Badge tone="neutral">no proof</Badge>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );

  return (
    <AppShell title="Payments" subtitle="Approval queue and ledger">
      {can(P.PAYMENT_APPROVE) ? (
        isTablet ? (
          <div className="grid grid-cols-[minmax(320px,1fr)_1fr] gap-4">
            <div>{queue}</div>
            <div>
              {selected ? (
                <ReviewPanel payment={selected} onDone={() => { setSelected(null); refresh(); }} />
              ) : (
                <Card className="flex h-full items-center justify-center">
                  <p className="text-sm text-content-muted">
                    Select a submission to review its proof and decide.
                  </p>
                </Card>
              )}
            </div>
          </div>
        ) : (
          <>
            {queue}
            {selected ? (
              <div className="mt-4">
                <ReviewPanel payment={selected} onDone={() => { setSelected(null); refresh(); }} />
              </div>
            ) : null}
          </>
        )
      ) : null}

      <div className="mt-6">
        <SectionHeading title="Approved payments" />
        {history.loading ? <Loading /> : null}
        {history.data ? (
          <DataTable
            columns={columns}
            rows={history.data.payments}
            keyOf={(row) => row.id}
            empty={<EmptyState title="No approved payments yet" />}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

function ReviewPanel({ payment, onDone }: { payment: Payment; onDone: () => void }) {
  const [amount, setAmount] = useState(String(payment.amount_paise / 100));
  const [reason, setReason] = useState('');

  const decide = useApiMutation<{ state: string }>((input: unknown) => ({
    path: `/api/payments/${payment.id}/decision`,
    body: input,
  }));

  // Reset the form when a different submission is selected.
  useEffect(() => {
    setAmount(String(payment.amount_paise / 100));
    setReason('');
  }, [payment.id, payment.amount_paise]);

  const approvedPaise = Math.round(Number(amount) * 100);
  const isPartial = approvedPaise !== payment.amount_paise;

  return (
    <Card>
      <SectionHeading
        title={payment.tenant_name}
        subtitle={`${payment.branch_name} · submitted ${formatDate(payment.created_at)}`}
      />

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-content-muted">Submitted</dt>
          <dd className="font-medium tabular-nums">{formatPaise(payment.amount_paise)}</dd>
        </div>
        <div>
          <dt className="text-xs text-content-muted">Bill outstanding</dt>
          <dd className="tabular-nums">
            {payment.bill_outstanding_paise === null
              ? '—'
              : formatPaise(payment.bill_outstanding_paise)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-content-muted">Method</dt>
          <dd>{payment.method}</dd>
        </div>
        <div>
          <dt className="text-xs text-content-muted">Reference</dt>
          <dd className="truncate">{payment.reference ?? '—'}</dd>
        </div>
      </dl>

      {payment.proofs && payment.proofs.length > 0 ? (
        <section className="mt-4">
          <h4 className="mb-2 text-sm font-semibold">Payment proof</h4>
          {payment.proofs.map((proof) => (
            <ProofView key={proof.id} proof={proof} />
          ))}
          <p className="mt-2 text-xs text-content-muted">
            Anything read from the screenshot is a suggestion only. The amount credited is the one
            you approve below.
          </p>
        </section>
      ) : (
        <p className="mt-4 rounded-lg bg-surface-sunken p-3 text-sm text-content-muted">
          No screenshot was attached to this submission.
        </p>
      )}

      <div className="mt-4 space-y-3">
        <Field
          label="Amount to approve (₹)"
          hint={isPartial ? 'This will be recorded as a partial approval' : undefined}
        >
          <TextInput
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>

        <Field label="Note" hint="Required when rejecting">
          <TextArea value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>

        {decide.error ? <p className="text-sm text-critical">{decide.error.message}</p> : null}

        {/* Stacked on phones so each target is full width; side by side once
            there is room. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            disabled={decide.pending}
            onClick={async () => {
              await decide.run(
                isPartial
                  ? { action: 'approve_partial', approvedAmountPaise: approvedPaise, reason: reason || undefined }
                  : { action: 'approve', reason: reason || undefined },
              );
              onDone();
            }}
          >
            {isPartial ? `Approve ${formatPaise(approvedPaise)}` : 'Approve in full'}
          </Button>
          <Button
            variant="danger"
            disabled={decide.pending || !reason}
            onClick={async () => {
              await decide.run({ action: 'reject', reason });
              onDone();
            }}
          >
            Reject
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Renders a payment screenshot.
 *
 * Fetched with the session token and shown from a blob, so the file is never
 * reachable by URL alone.
 */
function ProofView({ proof }: { proof: Proof }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    fetchFileObjectUrl(`/api/payments/proofs/${proof.id}/file`)
      .then((result) => {
        objectUrl = result;
        setUrl(result);
      })
      .catch(() => setFailed(true));

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [proof.id]);

  return (
    <div className="rounded-lg border border-border p-2">
      {failed ? (
        <p className="text-sm text-content-muted">Could not load {proof.originalName}.</p>
      ) : url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`Payment proof: ${proof.originalName}`}
          className="max-h-80 w-full rounded object-contain"
        />
      ) : (
        <Loading label="Loading proof" />
      )}

      {proof.ocrAmountPaise !== null || proof.ocrReference ? (
        <p className="mt-2 text-xs text-content-muted">
          Read from the image:
          {proof.ocrAmountPaise !== null ? ` ${formatPaise(proof.ocrAmountPaise)}` : ''}
          {proof.ocrReference ? ` · ref ${proof.ocrReference}` : ''}
          {proof.ocrProvider ? ` · ${proof.ocrProvider}` : ''}
        </p>
      ) : null}
    </div>
  );
}
