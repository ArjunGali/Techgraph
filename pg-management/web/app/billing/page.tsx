'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Loading,
  SectionHeading, Select, Sheet, cx, type Column,
} from '@/components/ui';
import { useApiQuery, useApiMutation } from '@/lib/useApi';
import { useLayoutShape } from '@/lib/useMediaQuery';
import { currentPeriodMonth, formatMonth, formatPaise } from '@/lib/format';
import { useAuth, P } from '@/lib/auth';

type Branch = { id: string; name: string };
type Period = {
  id: string; branch_id: string; branch_name: string; period_month: string; status: string;
  bill_count: number; total_paise: number; collected_paise: number; outstanding_paise: number;
  reopen_count: number;
};
type Bill = {
  id: string; tenant_name: string; tenant_code: string; period_month: string;
  rent_paise: number; eb_paise: number; common_charge_paise: number;
  previous_dues_paise: number; total_paise: number; paid_paise: number;
  outstanding_paise: number; payment_status: string; status: string;
};

/**
 * Monthly billing.
 *
 * Bills are produced by the calculation engine from stay history and meter
 * readings; nothing on this screen edits a figure. What the user controls is
 * when the month is generated, reviewed and closed.
 */
export default function BillingPage() {
  const { can } = useAuth();
  const { isTablet } = useLayoutShape();

  const branches = useApiQuery<{ branches: Branch[] }>('/api/property/branches');
  const [branchId, setBranchId] = useState('');
  const [periodMonth, setPeriodMonth] = useState(currentPeriodMonth());
  const [selectedBill, setSelectedBill] = useState<string | null>(null);

  const activeBranch = branchId || branches.data?.branches[0]?.id || '';

  const periods = useApiQuery<{ periods: Period[] }>(
    activeBranch ? '/api/billing/periods' : null,
    { branchId: activeBranch },
  );
  const bills = useApiQuery<{ bills: Bill[] }>(
    activeBranch ? '/api/billing/bills' : null,
    { branchId: activeBranch, periodMonth },
  );
  const readiness = useApiQuery<{
    ready: boolean;
    missingReadings: { meterId: string; meterCode: string }[];
    flaggedReadings: { id: string; meter_code: string; flag_reason: string }[];
  }>(
    activeBranch && can(P.BILLING_READ) ? '/api/billing/periods/readiness' : null,
    { branchId: activeBranch, periodMonth },
  );

  const generate = useApiMutation<{ billCount: number }>(() => ({
    path: '/api/billing/periods/generate',
    body: { branchId: activeBranch, periodMonth },
  }));
  const close = useApiMutation<{ ok: boolean }>(() => ({
    path: '/api/billing/periods/close',
    body: { branchId: activeBranch, periodMonth },
  }));

  const period = periods.data?.periods.find((item) => item.period_month === periodMonth);

  const columns: Column<Bill>[] = [
    {
      key: 'tenant',
      header: 'Tenant',
      primary: true,
      render: (row) => <span className="font-medium">{row.tenant_name}</span>,
    },
    { key: 'rent', header: 'Rent', align: 'right', render: (row) => formatPaise(row.rent_paise) },
    { key: 'eb', header: 'Electricity', align: 'right', render: (row) => formatPaise(row.eb_paise) },
    {
      key: 'common',
      header: 'Common',
      align: 'right',
      wideOnly: true,
      render: (row) => formatPaise(row.common_charge_paise),
    },
    {
      key: 'dues',
      header: 'Previous',
      align: 'right',
      wideOnly: true,
      render: (row) => formatPaise(row.previous_dues_paise),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      render: (row) => <span className="font-medium">{formatPaise(row.total_paise)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge
          tone={
            row.outstanding_paise <= 0
              ? 'positive'
              : row.payment_status === 'partially_paid'
                ? 'caution'
                : row.payment_status === 'pending_approval'
                  ? 'brand'
                  : 'critical'
          }
        >
          {row.payment_status.replace(/_/g, ' ')}
        </Badge>
      ),
    },
  ];

  const totals = (bills.data?.bills ?? []).reduce(
    (accumulator, bill) => ({
      total: accumulator.total + bill.total_paise,
      collected: accumulator.collected + bill.paid_paise,
      outstanding: accumulator.outstanding + bill.outstanding_paise,
    }),
    { total: 0, collected: 0, outstanding: 0 },
  );

  return (
    <AppShell
      title="Billing"
      subtitle={formatMonth(periodMonth)}
      actions={
        <>
          {can(P.BILLING_GENERATE) ? (
            <Button
              size="sm"
              disabled={!activeBranch || generate.pending || period?.status === 'closed'}
              onClick={async () => {
                await generate.run(undefined);
                bills.reload();
                periods.reload();
                readiness.reload();
              }}
            >
              {generate.pending ? 'Generating…' : 'Generate bills'}
            </Button>
          ) : null}
          {can(P.BILLING_CLOSE) && period && period.status !== 'closed' ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={close.pending}
              onClick={async () => {
                await close.run(undefined);
                periods.reload();
                bills.reload();
              }}
            >
              Close month
            </Button>
          ) : null}
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:max-w-xl">
        <Field label="Branch">
          <Select value={activeBranch} onChange={(event) => setBranchId(event.target.value)}>
            {branches.data?.branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Month">
          <Select value={periodMonth} onChange={(event) => setPeriodMonth(event.target.value)}>
            {monthOptions().map((month) => (
              <option key={month} value={month}>
                {formatMonth(month)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {period ? (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">
                {formatMonth(period.period_month)} · {period.bill_count} bill
                {period.bill_count === 1 ? '' : 's'}
              </p>
              <p className="text-sm text-content-muted">
                {formatPaise(totals.collected)} collected of {formatPaise(totals.total)}
              </p>
            </div>
            <Badge tone={period.status === 'closed' ? 'positive' : 'brand'}>{period.status}</Badge>
          </div>
          {period.status === 'closed' ? (
            <p className="mt-2 text-xs text-content-muted">
              This month is closed. Its figures are final and are not affected by later price
              changes or tenant moves.
              {period.reopen_count > 0 ? ` Reopened ${period.reopen_count} time(s).` : ''}
            </p>
          ) : null}
        </Card>
      ) : null}

      {readiness.data && !readiness.data.ready ? (
        <Card className="mb-4 border-caution/50">
          <p className="font-medium text-caution">Meter readings missing</p>
          <p className="mt-1 text-sm text-content-muted">
            Electricity cannot be apportioned for{' '}
            {readiness.data.missingReadings.map((meter) => meter.meterCode).join(', ')} until a
            reading is entered. The month cannot be closed without them.
          </p>
        </Card>
      ) : null}

      {readiness.data && readiness.data.flaggedReadings.length > 0 ? (
        <Card className="mb-4 border-caution/50">
          <p className="font-medium text-caution">Unusual readings to confirm</p>
          <ul className="mt-1 space-y-1 text-sm text-content-muted">
            {readiness.data.flaggedReadings.map((reading) => (
              <li key={reading.id}>
                {reading.meter_code}: {reading.flag_reason}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {generate.error ? (
        <Card className="mb-4 border-critical/50">
          <p className="text-sm text-critical">{generate.error.message}</p>
        </Card>
      ) : null}
      {close.error ? (
        <Card className="mb-4 border-critical/50">
          <p className="text-sm text-critical">{close.error.message}</p>
        </Card>
      ) : null}

      {bills.loading ? <Loading /> : null}
      {bills.error ? <ErrorState message={bills.error.message} onRetry={bills.reload} /> : null}

      {bills.data ? (
        <>
          <SectionHeading
            title="Bills"
            subtitle={`${bills.data.bills.length} tenant(s) · ${formatPaise(
              totals.outstanding,
            )} outstanding`}
          />
          <DataTable
            columns={columns}
            rows={bills.data.bills}
            keyOf={(row) => row.id}
            onRowClick={(row) => setSelectedBill(row.id)}
            empty={
              <EmptyState
                title="No bills for this month"
                message="Generate the month's bills once meter readings are in."
              />
            }
          />
        </>
      ) : null}

      <Sheet
        open={selectedBill !== null}
        onClose={() => setSelectedBill(null)}
        title="Bill breakdown"
      >
        {selectedBill ? <BillDetail billId={selectedBill} /> : null}
      </Sheet>

      {isTablet ? null : null}
    </AppShell>
  );
}

/** The last twelve months, newest first. */
function monthOptions(): string[] {
  const now = new Date();
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
  });
}

/**
 * The complete working behind one bill.
 *
 * Shows the whole electricity apportionment, not just this tenant's share, so
 * the split can be checked line by line rather than taken on trust.
 */
function BillDetail({ billId }: { billId: string }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApiQuery<{
    bill: Bill & { branch_name: string; tenant_phone: string };
    items: { id: string; item_type: string; description: string; amount_paise: number }[];
    calculation: { breakdown: { explanation: string[] } } | null;
    payments: { id: string; amount_paise: number; state: string; method: string }[];
  }>(`/api/billing/bills/${billId}`);

  const send = useApiMutation<{ status: string }>(() => ({
    path: `/api/messaging/bills/${billId}/send`,
  }));

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">{data.bill.tenant_name}</h3>
        <p className="text-sm text-content-muted">
          {formatMonth(data.bill.period_month)} · {data.bill.branch_name}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-surface-sunken p-3">
          <p className="text-xs text-content-muted">Total</p>
          <p className="text-lg font-semibold tabular-nums">{formatPaise(data.bill.total_paise)}</p>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <p className="text-xs text-content-muted">Outstanding</p>
          <p
            className={cx(
              'text-lg font-semibold tabular-nums',
              data.bill.outstanding_paise > 0 ? 'text-critical' : 'text-positive',
            )}
          >
            {formatPaise(data.bill.outstanding_paise)}
          </p>
        </div>
      </div>

      <section>
        <h4 className="mb-2 text-sm font-semibold">Charges</h4>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">{item.description}</span>
              <span className="shrink-0 tabular-nums">{formatPaise(item.amount_paise)}</span>
            </li>
          ))}
        </ul>
      </section>

      {data.calculation ? (
        <section>
          <h4 className="mb-2 text-sm font-semibold">How this was calculated</h4>
          {/* Preformatted so the alignment of the working survives; it scrolls
              inside its own box rather than widening the page. */}
          <pre className="scroll-x rounded-lg bg-surface-sunken p-3 text-xs leading-relaxed">
            {data.calculation.breakdown.explanation.join('\n')}
          </pre>
        </section>
      ) : null}

      {can(P.MESSAGE_SEND) ? (
        <Button
          fullWidth
          variant="secondary"
          disabled={send.pending}
          onClick={() => void send.run(undefined)}
        >
          {send.pending ? 'Sending…' : 'Send payment request'}
        </Button>
      ) : null}
      {send.error ? <p className="text-sm text-critical">{send.error.message}</p> : null}
    </div>
  );
}
