'use client';

import { AppShell } from '@/components/AppShell';
import { Badge, Card, EmptyState, ErrorState, Loading, SectionHeading, Stat } from '@/components/ui';
import { useApiQuery } from '@/lib/useApi';
import { formatDate } from '@/lib/format';

type Summary = {
  asOf: string;
  branches: { branch_id: string; branch_name: string; total_capacity: number; occupied: number; vacant: number }[];
  totals: { totalCapacity: number; occupied: number; vacant: number; occupancyPercent: number };
};

type Available = {
  rooms: {
    room_id: string; room_code: string; sharing_capacity: number; vacant_count: number;
    floor_name: string; branch_name: string;
  }[];
};

type Upcoming = {
  upcoming: {
    stay_id: string; end_date: string; available_from: string; days_until_free: number;
    tenant_name: string; room_code: string; sharing_capacity: number;
    floor_name: string; branch_name: string;
  }[];
};

/**
 * Vacancies, both now and coming.
 *
 * Nothing here is maintained by hand: a bed is free when no stay covers it,
 * and it is coming free when the stay covering it has an end date. Both fall
 * out of the same records that drive billing.
 */
export default function VacanciesPage() {
  const summary = useApiQuery<Summary>('/api/vacancies/summary');
  const available = useApiQuery<Available>('/api/vacancies/available');
  const upcoming = useApiQuery<Upcoming>('/api/vacancies/upcoming', { horizonDays: 60 });

  return (
    <AppShell title="Vacancies" subtitle="Available now and coming free">
      {summary.loading ? <Loading /> : null}
      {summary.error ? <ErrorState message={summary.error.message} onRetry={summary.reload} /> : null}

      {summary.data ? (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Capacity" value={String(summary.data.totals.totalCapacity)} hint="beds" />
          <Stat label="Occupied" value={String(summary.data.totals.occupied)} />
          <Stat
            label="Vacant"
            value={String(summary.data.totals.vacant)}
            tone={summary.data.totals.vacant > 0 ? 'caution' : 'default'}
          />
          <Stat label="Filled" value={`${summary.data.totals.occupancyPercent}%`} />
        </div>
      ) : null}

      {/* Side by side from small tablets up; stacked on phones. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section>
          <SectionHeading
            title="Available now"
            subtitle={available.data ? `${available.data.rooms.length} room(s) with space` : undefined}
          />
          {available.loading ? <Loading /> : null}
          {available.data?.rooms.length === 0 ? (
            <EmptyState title="Everything is full" message="No beds are free today." />
          ) : (
            <ul className="space-y-2">
              {available.data?.rooms.map((room) => (
                <li key={room.room_id}>
                  <Card className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{room.room_code}</p>
                      <p className="truncate text-sm text-content-muted">
                        {room.sharing_capacity} sharing · {room.floor_name} · {room.branch_name}
                      </p>
                    </div>
                    <Badge tone="positive">
                      {room.vacant_count} free
                    </Badge>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionHeading
            title="Coming free"
            subtitle="Next 60 days, from notice already given"
          />
          {upcoming.loading ? <Loading /> : null}
          {upcoming.data?.upcoming.length === 0 ? (
            <EmptyState title="No departures scheduled" message="Nobody has a leaving date set." />
          ) : (
            <ul className="space-y-2">
              {upcoming.data?.upcoming.map((item) => (
                <li key={item.stay_id}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{item.room_code}</p>
                        <p className="truncate text-sm text-content-muted">
                          {item.tenant_name} leaving {formatDate(item.end_date)}
                        </p>
                        <p className="truncate text-xs text-content-muted">
                          {item.floor_name} · {item.branch_name}
                        </p>
                      </div>
                      <Badge tone={item.days_until_free <= 7 ? 'caution' : 'neutral'}>
                        {item.days_until_free === 0
                          ? 'today'
                          : `${item.days_until_free}d`}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs text-content-muted">
                      Available from {formatDate(item.available_from)}
                    </p>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}
