'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Loading,
  SectionHeading, Select, Sheet, TextInput, cx, type Column,
} from '@/components/ui';
import { useApiQuery, useApiMutation } from '@/lib/useApi';
import { useLayoutShape } from '@/lib/useMediaQuery';
import { formatDate, formatPaise, todayIso } from '@/lib/format';
import { useAuth, P } from '@/lib/auth';

type TenantRow = {
  id: string; tenant_code: string; full_name: string; phone: string; status: string;
  joining_date: string; room_code: string | null; floor_name: string | null;
  branch_name: string | null; sharing_capacity: number | null;
  monthly_rent_paise: number | null; outstanding_paise: number | null;
};

export default function TenantsPageWrapper() {
  return (
    <Suspense fallback={null}>
      <TenantsPage />
    </Suspense>
  );
}

/**
 * Tenant search and detail.
 *
 * On a phone, picking a tenant opens their record as a full-height sheet. On a
 * tablet the list stays on the left and the record fills a detail pane, so an
 * owner working through a list of overdue tenants never loses their place.
 */
function TenantsPage() {
  const params = useSearchParams();
  const { isTablet } = useLayoutShape();
  const { can } = useAuth();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const roomId = params.get('roomId');

  const { data, error, loading, reload } = useApiQuery<{ tenants: TenantRow[] }>('/api/tenants', {
    q: search || undefined,
    status: status || undefined,
    roomId: roomId ?? undefined,
    limit: 200,
  });

  const columns: Column<TenantRow>[] = [
    {
      key: 'name',
      header: 'Tenant',
      primary: true,
      render: (row) => (
        <div className="min-w-0">
          <span className="block truncate font-medium">{row.full_name}</span>
          <span className="block truncate text-xs text-content-muted">{row.tenant_code}</span>
        </div>
      ),
    },
    { key: 'phone', header: 'Phone', render: (row) => row.phone },
    {
      key: 'room',
      header: 'Room',
      render: (row) => (row.room_code ? `${row.room_code}` : '—'),
    },
    {
      key: 'branch',
      header: 'Branch',
      wideOnly: true,
      render: (row) => row.branch_name ?? '—',
    },
    {
      key: 'rent',
      header: 'Rent',
      align: 'right',
      wideOnly: true,
      render: (row) => formatPaise(row.monthly_rent_paise),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge tone={row.status === 'active' ? 'positive' : 'neutral'}>{row.status}</Badge>
      ),
    },
    {
      key: 'due',
      header: 'Outstanding',
      align: 'right',
      render: (row) =>
        row.outstanding_paise === null ? (
          '—'
        ) : (
          <span className={cx(row.outstanding_paise > 0 && 'text-critical')}>
            {formatPaise(row.outstanding_paise)}
          </span>
        ),
    },
  ];

  const list = (
    <>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr]">
        <TextInput
          type="search"
          inputMode="search"
          placeholder="Search name, phone or tenant ID"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="notice">On notice</option>
          <option value="vacated">Vacated</option>
        </Select>
      </div>

      {loading ? <Loading /> : null}
      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}
      {data ? (
        <DataTable
          columns={columns}
          rows={data.tenants}
          keyOf={(row) => row.id}
          onRowClick={(row) => setSelectedId(row.id)}
          empty={
            <EmptyState
              title="No tenants found"
              message={search ? 'Try a different search.' : 'Add a tenant to get started.'}
            />
          }
        />
      ) : null}
    </>
  );

  return (
    <AppShell
      title="Tenants"
      subtitle={data ? `${data.tenants.length} shown` : undefined}
      actions={
        can(P.TENANT_WRITE) ? (
          <Button size="sm" onClick={() => setSelectedId('new')}>
            Add tenant
          </Button>
        ) : undefined
      }
    >
      {isTablet ? (
        <div className="grid grid-cols-[minmax(320px,1fr)_1.2fr] gap-4 lg:grid-cols-[minmax(380px,1fr)_1.5fr]">
          <div>{list}</div>
          <div>
            {selectedId && selectedId !== 'new' ? (
              <TenantDetail tenantId={selectedId} onChanged={reload} />
            ) : (
              <Card className="flex h-full items-center justify-center">
                <p className="text-sm text-content-muted">
                  Select a tenant to see their stay history, bills and payments.
                </p>
              </Card>
            )}
          </div>
        </div>
      ) : (
        <>
          {list}
          <Sheet
            open={selectedId !== null && selectedId !== 'new'}
            onClose={() => setSelectedId(null)}
            title="Tenant"
          >
            {selectedId && selectedId !== 'new' ? (
              <TenantDetail tenantId={selectedId} onChanged={reload} />
            ) : null}
          </Sheet>
        </>
      )}

      <NewTenantSheet
        open={selectedId === 'new'}
        onClose={() => setSelectedId(null)}
        onCreated={() => {
          setSelectedId(null);
          reload();
        }}
      />
    </AppShell>
  );
}

type Stay = {
  id: string; start_date: string; end_date: string | null; room_code: string;
  floor_name: string; branch_name: string; sharing_capacity: number;
  monthly_rent_paise: number; status: string; ended_reason: string | null;
  bed_label: string | null;
};

function TenantDetail({ tenantId, onChanged }: { tenantId: string; onChanged: () => void }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApiQuery<{
    tenant: TenantRow & { joining_date: string; deposit_paise: number; exit_date: string | null };
    stays: Stay[];
    currentStay: Stay | null;
    bills: { id: string; period_month: string; total_paise: number; outstanding_paise: number; payment_status: string }[];
    payments: { id: string; amount_paise: number; state: string; created_at: string; method: string }[];
    documents: { id: string; doc_type: string; masked_identifier: string | null; is_verified: boolean }[];
  }>(`/api/tenants/${tenantId}`);

  const [moveOpen, setMoveOpen] = useState(false);
  const [vacateOpen, setVacateOpen] = useState(false);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return null;

  const refresh = () => {
    reload();
    onChanged();
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{data.tenant.full_name}</h2>
            <p className="text-sm text-content-muted">
              {data.tenant.tenant_code} · {data.tenant.phone}
            </p>
          </div>
          <Badge tone={data.tenant.status === 'active' ? 'positive' : 'neutral'}>
            {data.tenant.status}
          </Badge>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-content-muted">Joined</dt>
            <dd>{formatDate(data.tenant.joining_date)}</dd>
          </div>
          <div>
            <dt className="text-xs text-content-muted">Deposit</dt>
            <dd>{formatPaise(data.tenant.deposit_paise)}</dd>
          </div>
          {data.currentStay ? (
            <>
              <div>
                <dt className="text-xs text-content-muted">Room</dt>
                <dd>{data.currentStay.room_code}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Floor</dt>
                <dd>{data.currentStay.floor_name}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Branch</dt>
                <dd>{data.currentStay.branch_name}</dd>
              </div>
              <div>
                <dt className="text-xs text-content-muted">Rent</dt>
                <dd>{formatPaise(data.currentStay.monthly_rent_paise)}</dd>
              </div>
            </>
          ) : null}
        </dl>

        {can(P.TENANT_MOVE) && data.currentStay ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setMoveOpen(true)}>
              Move room
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setVacateOpen(true)}>
              Vacate
            </Button>
          </div>
        ) : null}
      </Card>

      <section>
        <SectionHeading
          title="Stay history"
          subtitle="Every period is kept — a move never overwrites where they were"
        />
        <ul className="space-y-2">
          {data.stays.map((stay) => (
            <li key={stay.id}>
              <Card className={cx('text-sm', stay.end_date === null && 'border-brand/40')}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">
                    {stay.room_code} · {stay.sharing_capacity} sharing
                  </p>
                  {stay.end_date === null ? (
                    <Badge tone="brand">Current</Badge>
                  ) : (
                    <Badge tone="neutral">{stay.ended_reason ?? 'ended'}</Badge>
                  )}
                </div>
                <p className="mt-1 text-content-muted">
                  {formatDate(stay.start_date)} — {stay.end_date ? formatDate(stay.end_date) : 'present'}
                  {stay.bed_label ? ` · ${stay.bed_label}` : ''}
                </p>
                <p className="mt-0.5 text-content-muted">
                  {formatPaise(stay.monthly_rent_paise)} per month · {stay.branch_name}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      {data.bills.length > 0 ? (
        <section>
          <SectionHeading title="Bills" />
          <ul className="space-y-2">
            {data.bills.slice(0, 6).map((bill) => (
              <li key={bill.id}>
                <Card className="flex items-center justify-between gap-3 text-sm">
                  <div>
                    <p className="font-medium">{bill.period_month.slice(0, 7)}</p>
                    <p className="text-content-muted">{formatPaise(bill.total_paise)} billed</p>
                  </div>
                  <div className="text-right">
                    <Badge
                      tone={
                        bill.outstanding_paise <= 0
                          ? 'positive'
                          : bill.payment_status === 'partially_paid'
                            ? 'caution'
                            : 'critical'
                      }
                    >
                      {bill.payment_status.replace(/_/g, ' ')}
                    </Badge>
                    {bill.outstanding_paise > 0 ? (
                      <p className="mt-1 text-content-muted">
                        {formatPaise(bill.outstanding_paise)} due
                      </p>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.documents.length > 0 ? (
        <section>
          <SectionHeading title="Documents" subtitle="Identifiers are masked; access is audited" />
          <ul className="space-y-2">
            {data.documents.map((document) => (
              <li key={document.id}>
                <Card className="flex items-center justify-between gap-3 text-sm">
                  <span className="capitalize">{document.doc_type.replace(/_/g, ' ')}</span>
                  <span className="text-content-muted">
                    {document.masked_identifier ?? 'on file'}
                    {document.is_verified ? ' · verified' : ''}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <MoveSheet
        open={moveOpen}
        tenantId={tenantId}
        onClose={() => setMoveOpen(false)}
        onDone={() => {
          setMoveOpen(false);
          refresh();
        }}
      />
      <VacateSheet
        open={vacateOpen}
        tenantId={tenantId}
        onClose={() => setVacateOpen(false)}
        onDone={() => {
          setVacateOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

type RoomOption = {
  id: string; code: string; sharing_capacity: number; vacant_count: number;
  branch_name: string; floor_name: string;
};

function useVacantRooms() {
  return useApiQuery<{ rooms: RoomOption[] }>('/api/vacancies/available');
}

function MoveSheet({
  open, tenantId, onClose, onDone,
}: {
  open: boolean; tenantId: string; onClose: () => void; onDone: () => void;
}) {
  const rooms = useVacantRooms();
  const [toRoomId, setToRoomId] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [reason, setReason] = useState('');

  const move = useApiMutation<{ stayId: string }>((input: unknown) => ({
    path: `/api/tenants/${tenantId}/move`,
    body: input,
  }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Move to another room"
      footer={
        <Button
          fullWidth
          disabled={!toRoomId || move.pending}
          onClick={async () => {
            await move.run({ toRoomId, effectiveDate, reason: reason || null });
            onDone();
          }}
        >
          {move.pending ? 'Moving…' : 'Confirm move'}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-content-muted">
          The current stay is closed the day before this date and a new one starts on it, so the
          tenant&apos;s previous room stays on record and the month&apos;s bill charges each period at
          its own rate.
        </p>

        <Field label="Move to">
          <Select value={toRoomId} onChange={(event) => setToRoomId(event.target.value)}>
            <option value="">Choose a room with space</option>
            {rooms.data?.rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.code} — {room.sharing_capacity} sharing, {room.vacant_count} free (
                {room.branch_name})
              </option>
            ))}
          </Select>
        </Field>

        <Field label="First day in the new room">
          <TextInput
            type="date"
            value={effectiveDate}
            onChange={(event) => setEffectiveDate(event.target.value)}
          />
        </Field>

        <Field label="Reason" hint="Optional, recorded in the audit trail">
          <TextInput value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>

        {move.error ? <p className="text-sm text-critical">{move.error.message}</p> : null}
      </div>
    </Sheet>
  );
}

function VacateSheet({
  open, tenantId, onClose, onDone,
}: {
  open: boolean; tenantId: string; onClose: () => void; onDone: () => void;
}) {
  const [lastDate, setLastDate] = useState(todayIso());
  const [reason, setReason] = useState('');

  const vacate = useApiMutation<{ stayId: string }>((input: unknown) => ({
    path: `/api/tenants/${tenantId}/vacate`,
    body: input,
  }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Vacate"
      footer={
        <Button
          fullWidth
          variant="danger"
          disabled={vacate.pending}
          onClick={async () => {
            await vacate.run({ lastDate, reason: reason || null });
            onDone();
          }}
        >
          {vacate.pending ? 'Recording…' : 'Confirm vacate'}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-content-muted">
          The stay is closed on this date, which is counted as a day of residence. Their bed becomes
          available the following day and their bills for the month are prorated to the days stayed.
        </p>

        <Field label="Last day of stay">
          <TextInput
            type="date"
            value={lastDate}
            onChange={(event) => setLastDate(event.target.value)}
          />
        </Field>

        <Field label="Reason" hint="Optional">
          <TextInput value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>

        {vacate.error ? <p className="text-sm text-critical">{vacate.error.message}</p> : null}
      </div>
    </Sheet>
  );
}

function NewTenantSheet({
  open, onClose, onCreated,
}: {
  open: boolean; onClose: () => void; onCreated: () => void;
}) {
  const rooms = useVacantRooms();
  const [form, setForm] = useState({
    fullName: '', phone: '', joiningDate: todayIso(), roomId: '', depositPaise: '',
  });

  const create = useApiMutation<{ tenantId: string }>((input: unknown) => ({
    path: '/api/tenants',
    body: input,
  }));

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add tenant"
      footer={
        <Button
          fullWidth
          disabled={!form.fullName || !form.phone || create.pending}
          onClick={async () => {
            await create.run({
              fullName: form.fullName,
              phone: form.phone,
              joiningDate: form.joiningDate,
              roomId: form.roomId || undefined,
              // Entered in rupees, sent as paise — the API never sees a float.
              depositPaise: form.depositPaise ? Math.round(Number(form.depositPaise) * 100) : 0,
            });
            onCreated();
          }}
        >
          {create.pending ? 'Adding…' : 'Add tenant'}
        </Button>
      }
    >
      {/* Full-width fields on a phone, paired on anything wider. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <TextInput value={form.fullName} onChange={set('fullName')} autoCapitalize="words" />
        </Field>
        <Field label="Phone">
          <TextInput value={form.phone} onChange={set('phone')} inputMode="tel" />
        </Field>
        <Field label="Joining date">
          <TextInput type="date" value={form.joiningDate} onChange={set('joiningDate')} />
        </Field>
        <Field label="Deposit (₹)" hint="Optional">
          <TextInput
            value={form.depositPaise}
            onChange={set('depositPaise')}
            inputMode="decimal"
            placeholder="10000"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Room" hint="The rent is taken from the price in force on the joining date">
            <Select value={form.roomId} onChange={set('roomId')}>
              <option value="">Assign later</option>
              {rooms.data?.rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.code} — {room.sharing_capacity} sharing, {room.vacant_count} free (
                  {room.branch_name})
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {create.error ? <p className="mt-3 text-sm text-critical">{create.error.message}</p> : null}
    </Sheet>
  );
}
