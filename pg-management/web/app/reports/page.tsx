'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import {
  Card, DataTable, ErrorState, Field, Loading, SectionHeading, Select, Stat, type Column,
} from '@/components/ui';
import { useApiQuery } from '@/lib/useApi';
import { currentPeriodMonth, formatMonth, formatPaise, formatRupees } from '@/lib/format';
import { useAuth, P } from '@/lib/auth';

type OccupancyRoom = {
  room_id: string; room_code: string; branch_name: string; floor_name: string;
  sharing_capacity: number; occupied: number; vacant: number;
};

type Financial = {
  periodMonth: string;
  billing: {
    branch_id: string; branch_name: string; bill_count: number; rent_paise: number;
    eb_paise: number; common_charge_paise: number; expected_paise: number;
    collected_paise: number; outstanding_paise: number;
  }[];
  expenses: { category: string; amount_paise: number }[];
  totals: {
    expectedPaise: number; collectedPaise: number; outstandingPaise: number;
    expensePaise: number; netPaise: number;
  };
};

/** Reports. Financial figures require the finance permission, checked server-side. */
export default function ReportsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'occupancy' | 'financial' | 'tenants'>('occupancy');
  const [periodMonth, setPeriodMonth] = useState(currentPeriodMonth());

  const tabs = [
    { id: 'occupancy' as const, label: 'Occupancy', allowed: true },
    { id: 'financial' as const, label: 'Financial', allowed: can(P.REPORT_FINANCE) },
    { id: 'tenants' as const, label: 'Tenants', allowed: true },
  ].filter((item) => item.allowed);

  return (
    <AppShell title="Reports">
      {/* A scrollable tab strip on a phone, an ordinary row on a tablet. */}
      <div className="no-scrollbar mb-4 flex gap-2 overflow-x-auto">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={
              'min-h-tap shrink-0 rounded-lg px-4 text-sm font-medium ' +
              (tab === item.id
                ? 'bg-brand text-brand-contrast'
                : 'border border-border bg-surface-raised text-content')
            }
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab !== 'occupancy' ? (
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
      ) : null}

      {tab === 'occupancy' ? <OccupancyReport /> : null}
      {tab === 'financial' ? <FinancialReport periodMonth={periodMonth} /> : null}
      {tab === 'tenants' ? <TenantReport /> : null}
    </AppShell>
  );
}

function OccupancyReport() {
  const { data, error, loading, reload } = useApiQuery<{
    rooms: OccupancyRoom[];
    totals: { capacity: number; occupied: number; vacant: number; occupancyPercent: number };
    upcomingVacancies: { end_date: string; tenant_name: string; room_code: string; branch_name: string }[];
  }>('/api/reports/occupancy');

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return null;

  const columns: Column<OccupancyRoom>[] = [
    { key: 'room', header: 'Room', primary: true, render: (row) => row.room_code },
    { key: 'branch', header: 'Branch', render: (row) => row.branch_name },
    { key: 'floor', header: 'Floor', wideOnly: true, render: (row) => row.floor_name },
    { key: 'capacity', header: 'Capacity', align: 'right', render: (row) => row.sharing_capacity },
    { key: 'occupied', header: 'Occupied', align: 'right', render: (row) => row.occupied },
    { key: 'vacant', header: 'Vacant', align: 'right', render: (row) => row.vacant },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Capacity" value={String(data.totals.capacity)} />
        <Stat label="Occupied" value={String(data.totals.occupied)} />
        <Stat label="Vacant" value={String(data.totals.vacant)} tone="caution" />
        <Stat label="Filled" value={`${data.totals.occupancyPercent}%`} />
      </div>
      <DataTable columns={columns} rows={data.rooms} keyOf={(row) => row.room_id} />
    </div>
  );
}

function FinancialReport({ periodMonth }: { periodMonth: string }) {
  const { data, error, loading, reload } = useApiQuery<Financial>('/api/reports/financial', {
    periodMonth,
  });

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Expected" value={formatRupees(data.totals.expectedPaise)} />
        <Stat label="Collected" value={formatRupees(data.totals.collectedPaise)} tone="positive" />
        <Stat label="Outstanding" value={formatRupees(data.totals.outstandingPaise)} tone="caution" />
        <Stat label="Expenses" value={formatRupees(data.totals.expensePaise)} />
        <Stat
          label="Net"
          value={formatRupees(data.totals.netPaise)}
          tone={data.totals.netPaise >= 0 ? 'positive' : 'critical'}
        />
      </div>

      <section>
        <SectionHeading title="By branch" />
        <DataTable
          columns={[
            { key: 'branch', header: 'Branch', primary: true, render: (row) => row.branch_name },
            { key: 'bills', header: 'Bills', align: 'right', render: (row) => row.bill_count },
            { key: 'rent', header: 'Rent', align: 'right', render: (row) => formatPaise(row.rent_paise) },
            { key: 'eb', header: 'Electricity', align: 'right', render: (row) => formatPaise(row.eb_paise) },
            {
              key: 'expected', header: 'Expected', align: 'right',
              render: (row) => formatPaise(row.expected_paise),
            },
            {
              key: 'collected', header: 'Collected', align: 'right',
              render: (row) => formatPaise(row.collected_paise),
            },
            {
              key: 'outstanding', header: 'Outstanding', align: 'right',
              render: (row) => formatPaise(row.outstanding_paise),
            },
          ]}
          rows={data.billing}
          keyOf={(row) => row.branch_id}
        />
      </section>

      {data.expenses.length > 0 ? (
        <section>
          <SectionHeading title="Expenses" subtitle={formatMonth(periodMonth)} />
          <Card>
            <ul className="divide-y divide-border">
              {data.expenses.map((expense) => (
                <li key={expense.category} className="flex justify-between py-2 text-sm">
                  <span className="capitalize">{expense.category}</span>
                  <span className="tabular-nums">{formatPaise(expense.amount_paise)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </div>
  );
}

function TenantReport() {
  const { data, error, loading, reload } = useApiQuery<{
    summary: { active: number; new_joiners: number; vacated: number; missing_documents: number };
    movements: {
      id: string; start_date: string; end_date: string | null; tenant_name: string;
      room_code: string; branch_name: string; event: string;
    }[];
  }>('/api/reports/tenants');

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Active" value={String(data.summary.active)} />
        <Stat label="New" value={String(data.summary.new_joiners)} />
        <Stat label="Vacated" value={String(data.summary.vacated)} />
        <Stat
          label="Missing docs"
          value={String(data.summary.missing_documents)}
          tone={data.summary.missing_documents > 0 ? 'caution' : 'default'}
        />
      </div>

      <section>
        <SectionHeading title="Recent movements" />
        <DataTable
          columns={[
            { key: 'tenant', header: 'Tenant', primary: true, render: (row) => row.tenant_name },
            { key: 'event', header: 'Event', render: (row) => row.event },
            { key: 'room', header: 'Room', render: (row) => row.room_code },
            { key: 'branch', header: 'Branch', wideOnly: true, render: (row) => row.branch_name },
            { key: 'from', header: 'From', render: (row) => row.start_date },
          ]}
          rows={data.movements}
          keyOf={(row) => row.id}
        />
      </section>
    </div>
  );
}
