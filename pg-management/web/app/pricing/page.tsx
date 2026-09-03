'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Loading,
  SectionHeading, Select, Sheet, TextInput, type Column,
} from '@/components/ui';
import { useApiQuery, useApiMutation } from '@/lib/useApi';
import { formatDate, formatPaise, todayIso } from '@/lib/format';
import { useAuth, P } from '@/lib/auth';

type PriceRule = {
  id: string; branch_name: string | null; room_code: string | null;
  sharing_capacity: number | null; monthly_rent_paise: number;
  effective_from: string; effective_to: string | null; note: string | null;
};

type Rate = {
  id: string; charge: string; value_paise: number; branch_name: string | null;
  effective_from: string; effective_to: string | null;
};

/**
 * Rent prices and the administered rates.
 *
 * Changing a price never rewrites the old one: the current rule is closed the
 * day before the new one starts, so a bill from a past month still recomputes
 * at the price that actually applied then.
 *
 * These are the values the calculation engine consumes. The arithmetic itself
 * is not editable from the app by any role.
 */
export default function PricingPage() {
  const { can } = useAuth();
  const [newPrice, setNewPrice] = useState(false);
  const [newRate, setNewRate] = useState(false);

  const rules = useApiQuery<{ rules: PriceRule[] }>('/api/pricing/rules');
  const rates = useApiQuery<{ rates: Rate[] }>('/api/pricing/rates');

  const priceColumns: Column<PriceRule>[] = [
    {
      key: 'scope',
      header: 'Applies to',
      primary: true,
      render: (row) =>
        row.room_code
          ? `Room ${row.room_code}`
          : row.sharing_capacity
            ? `${row.sharing_capacity} sharing${row.branch_name ? ` — ${row.branch_name}` : ''}`
            : (row.branch_name ?? 'All'),
    },
    {
      key: 'rent',
      header: 'Monthly rent',
      align: 'right',
      render: (row) => formatPaise(row.monthly_rent_paise),
    },
    { key: 'from', header: 'From', render: (row) => formatDate(row.effective_from) },
    {
      key: 'to',
      header: 'Until',
      render: (row) =>
        row.effective_to ? formatDate(row.effective_to) : <Badge tone="positive">current</Badge>,
    },
    { key: 'note', header: 'Note', wideOnly: true, render: (row) => row.note ?? '—' },
  ];

  return (
    <AppShell
      title="Pricing"
      subtitle="Effective-dated — history is never overwritten"
      actions={
        can(P.PRICING_WRITE) ? (
          <>
            <Button size="sm" onClick={() => setNewPrice(true)}>
              Change rent
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setNewRate(true)}>
              Change rate
            </Button>
          </>
        ) : undefined
      }
    >
      <section className="mb-6">
        <SectionHeading title="Administered rates" subtitle="Inputs to the calculation engine" />
        {rates.loading ? <Loading /> : null}
        {rates.data ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rates.data.rates
              .filter((rate) => rate.effective_to === null)
              .map((rate) => (
                <Card key={rate.id}>
                  <p className="text-xs uppercase tracking-wide text-content-muted">
                    {rate.charge === 'eb_rate' ? 'Electricity rate' : 'Common charge'}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {formatPaise(rate.value_paise)}
                    <span className="ml-1 text-sm font-normal text-content-muted">
                      {rate.charge === 'eb_rate' ? 'per unit' : 'per tenant'}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-content-muted">
                    In force since {formatDate(rate.effective_from)}
                    {rate.branch_name ? ` · ${rate.branch_name}` : ' · all branches'}
                  </p>
                </Card>
              ))}
          </div>
        ) : null}
      </section>

      <section>
        <SectionHeading title="Rent prices" subtitle="Current and historical" />
        {rules.loading ? <Loading /> : null}
        {rules.error ? <ErrorState message={rules.error.message} onRetry={rules.reload} /> : null}
        {rules.data ? (
          <DataTable
            columns={priceColumns}
            rows={rules.data.rules}
            keyOf={(row) => row.id}
            empty={<EmptyState title="No prices configured" />}
          />
        ) : null}
      </section>

      <NewPriceSheet
        open={newPrice}
        onClose={() => setNewPrice(false)}
        onSaved={() => {
          setNewPrice(false);
          rules.reload();
        }}
      />
      <NewRateSheet
        open={newRate}
        onClose={() => setNewRate(false)}
        onSaved={() => {
          setNewRate(false);
          rates.reload();
        }}
      />
    </AppShell>
  );
}

function NewPriceSheet({
  open, onClose, onSaved,
}: {
  open: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [sharingCapacity, setSharingCapacity] = useState('5');
  const [rent, setRent] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [note, setNote] = useState('');

  const create = useApiMutation<{ id: string }>((input: unknown) => ({
    path: '/api/pricing/rules',
    body: input,
  }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Change rent"
      footer={
        <Button
          fullWidth
          disabled={!rent || create.pending}
          onClick={async () => {
            await create.run({
              sharingCapacity: Number(sharingCapacity),
              monthlyRentPaise: Math.round(Number(rent) * 100),
              effectiveFrom,
              note: note || null,
            });
            setRent('');
            setNote('');
            onSaved();
          }}
        >
          {create.pending ? 'Saving…' : 'Set new price'}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-content-muted">
          The current price for this sharing size is closed the day before the date below, and the
          new one takes over from it. Bills already issued keep the price they were calculated with.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Sharing size">
            <Select
              value={sharingCapacity}
              onChange={(event) => setSharingCapacity(event.target.value)}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((size) => (
                <option key={size} value={size}>
                  {size} sharing
                </option>
              ))}
            </Select>
          </Field>
          <Field label="New monthly rent (₹)">
            <TextInput
              inputMode="decimal"
              value={rent}
              onChange={(event) => setRent(event.target.value)}
              placeholder="7500"
            />
          </Field>
          <Field label="Effective from">
            <TextInput
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </Field>
          <Field label="Note" hint="Optional">
            <TextInput value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </div>

        {create.error ? <p className="text-sm text-critical">{create.error.message}</p> : null}
      </div>
    </Sheet>
  );
}

function NewRateSheet({
  open, onClose, onSaved,
}: {
  open: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [charge, setCharge] = useState<'eb_rate' | 'common_charge'>('eb_rate');
  const [value, setValue] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());

  const create = useApiMutation<{ id: string }>((input: unknown) => ({
    path: '/api/pricing/rates',
    body: input,
  }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Change an administered rate"
      footer={
        <Button
          fullWidth
          disabled={!value || create.pending}
          onClick={async () => {
            await create.run({
              charge,
              valuePaise: Math.round(Number(value) * 100),
              effectiveFrom,
            });
            setValue('');
            onSaved();
          }}
        >
          {create.pending ? 'Saving…' : 'Set new rate'}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-content-muted">
          These values feed the calculation engine. The formula that uses them — units × rate,
          shared out by occupancy days, plus the common charge — is fixed and cannot be edited from
          the app.
        </p>

        <Field label="Rate">
          <Select
            value={charge}
            onChange={(event) => setCharge(event.target.value as 'eb_rate' | 'common_charge')}
          >
            <option value="eb_rate">Electricity rate (per unit)</option>
            <option value="common_charge">Common charge (per tenant)</option>
          </Select>
        </Field>

        <Field label="New value (₹)">
          <TextInput
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={charge === 'eb_rate' ? '12.50' : '150'}
          />
        </Field>

        <Field label="Effective from">
          <TextInput
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </Field>

        {create.error ? <p className="text-sm text-critical">{create.error.message}</p> : null}
      </div>
    </Sheet>
  );
}
