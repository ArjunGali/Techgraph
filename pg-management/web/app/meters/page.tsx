'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, Loading, SectionHeading,
  Select, Sheet, TextInput,
} from '@/components/ui';
import { useApiQuery, useApiMutation } from '@/lib/useApi';
import { currentPeriodMonth, formatDate, formatMonth, formatPaise, todayIso } from '@/lib/format';
import { useAuth, P } from '@/lib/auth';

type Meter = {
  id: string; code: string; label: string; branch_name: string; floor_name: string | null;
  room_count: number; last_period: string | null; last_reading: number | null;
  last_reading_date: string | null;
};

type Reading = {
  id: string; meter_code: string; period_month: string; reading_date: string;
  previous_reading: number; current_reading: number; units_consumed: number;
  eb_rate_paise: number; status: string; flag_reason: string | null;
};

/**
 * Meter readings.
 *
 * A reading below the previous one is refused outright; one far above this
 * meter's recent norm is accepted but flagged, so a genuine spike is recorded
 * while still reaching the owner before tenants are billed for it.
 */
export default function MetersPage() {
  const { can } = useAuth();
  const [periodMonth, setPeriodMonth] = useState(currentPeriodMonth());
  const [entryFor, setEntryFor] = useState<Meter | null>(null);

  const meters = useApiQuery<{ meters: Meter[] }>('/api/meters');
  const readings = useApiQuery<{ readings: Reading[] }>('/api/meters/readings', { periodMonth });

  const readingByMeter = new Map(
    (readings.data?.readings ?? []).map((reading) => [reading.meter_code, reading]),
  );

  return (
    <AppShell title="Electricity" subtitle={formatMonth(periodMonth)}>
      <div className="mb-4 sm:max-w-xs">
        <Field label="Month">
          <Select value={periodMonth} onChange={(event) => setPeriodMonth(event.target.value)}>
            {Array.from({ length: 12 }, (_, index) => {
              const now = new Date();
              const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
              return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
            }).map((month) => (
              <option key={month} value={month}>
                {formatMonth(month)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {meters.loading ? <Loading /> : null}
      {meters.error ? <ErrorState message={meters.error.message} onRetry={meters.reload} /> : null}

      {meters.data ? (
        meters.data.meters.length === 0 ? (
          <EmptyState title="No meters configured" message="Add a meter to a floor to bill electricity." />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {meters.data.meters.map((meter) => {
              const reading = readingByMeter.get(meter.code);
              return (
                <Card key={meter.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{meter.code}</p>
                      <p className="truncate text-sm text-content-muted">{meter.label}</p>
                    </div>
                    {reading ? (
                      <Badge tone={reading.status === 'flagged' ? 'caution' : 'positive'}>
                        {reading.status}
                      </Badge>
                    ) : (
                      <Badge tone="critical">missing</Badge>
                    )}
                  </div>

                  {reading ? (
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <dt className="text-xs text-content-muted">Previous</dt>
                        <dd className="tabular-nums">{reading.previous_reading}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-content-muted">Current</dt>
                        <dd className="tabular-nums">{reading.current_reading}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-content-muted">Units</dt>
                        <dd className="tabular-nums">{reading.units_consumed}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-content-muted">Total</dt>
                        <dd className="tabular-nums">
                          {formatPaise(Math.round(reading.units_consumed * reading.eb_rate_paise))}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-3 text-sm text-content-muted">
                      No reading for {formatMonth(periodMonth)}.
                      {meter.last_reading !== null
                        ? ` Last recorded ${meter.last_reading} on ${formatDate(meter.last_reading_date)}.`
                        : ''}
                    </p>
                  )}

                  {reading?.flag_reason ? (
                    <p className="mt-2 rounded bg-caution/10 p-2 text-xs text-caution">
                      {reading.flag_reason}
                    </p>
                  ) : null}

                  {can(P.METER_WRITE) ? (
                    <div className="mt-3">
                      <Button size="sm" variant="secondary" fullWidth onClick={() => setEntryFor(meter)}>
                        {reading ? 'Update reading' : 'Enter reading'}
                      </Button>
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )
      ) : null}

      <ReadingSheet
        meter={entryFor}
        periodMonth={periodMonth}
        onClose={() => setEntryFor(null)}
        onSaved={() => {
          setEntryFor(null);
          readings.reload();
          meters.reload();
        }}
      />
    </AppShell>
  );
}

function ReadingSheet({
  meter, periodMonth, onClose, onSaved,
}: {
  meter: Meter | null; periodMonth: string; onClose: () => void; onSaved: () => void;
}) {
  const [currentReading, setCurrentReading] = useState('');
  const [readingDate, setReadingDate] = useState(todayIso());

  const save = useApiMutation<{ unitsConsumed: number; flagged: boolean }>((input: unknown) => ({
    path: '/api/meters/readings',
    body: input,
  }));

  return (
    <Sheet
      open={meter !== null}
      onClose={onClose}
      title={meter ? `Reading for ${meter.code}` : 'Reading'}
      footer={
        <Button
          fullWidth
          disabled={!currentReading || save.pending}
          onClick={async () => {
            await save.run({
              meterId: meter!.id,
              periodMonth,
              readingDate,
              currentReading: Number(currentReading),
            });
            setCurrentReading('');
            onSaved();
          }}
        >
          {save.pending ? 'Saving…' : 'Save reading'}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-content-muted">
          The previous reading is carried forward from last month automatically. Electricity is
          apportioned across the tenants who were actually behind this meter, by the days each of
          them stayed.
        </p>

        <Field label="Current reading">
          <TextInput
            inputMode="decimal"
            value={currentReading}
            onChange={(event) => setCurrentReading(event.target.value)}
            placeholder={meter?.last_reading !== null ? `Above ${meter?.last_reading}` : '0'}
          />
        </Field>

        <Field label="Reading date">
          <TextInput
            type="date"
            value={readingDate}
            onChange={(event) => setReadingDate(event.target.value)}
          />
        </Field>

        {save.error ? <p className="text-sm text-critical">{save.error.message}</p> : null}
      </div>
    </Sheet>
  );
}
