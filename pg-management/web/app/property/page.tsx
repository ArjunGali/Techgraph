'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import {
  Badge, Card, EmptyState, ErrorState, Loading, SectionHeading, cx,
} from '@/components/ui';
import { useApiQuery } from '@/lib/useApi';
import { useLayoutShape } from '@/lib/useMediaQuery';

type Branch = {
  id: string; code: string; name: string; city: string | null; status: string;
  floor_count: number; room_count: number; bed_count: number;
};

type Room = {
  id: string; floor_id: string; code: string; name: string | null;
  sharing_capacity: number; occupied_count: number; vacant_count: number;
  meter_code: string | null;
};

type Floor = { id: string; code: string; name: string; sort_order: number; rooms: Room[] };

/**
 * Branch → Floor → Room navigation.
 *
 * The user-facing path stays simple even though the data underneath is a full
 * relational hierarchy down to individual beds.
 *
 * On a phone this is a drill-down: pick a branch, then see its floors. On a
 * tablet the branch list becomes a left pane with the selected branch's floors
 * beside it, so no navigation step is needed to compare two branches.
 */
export default function PropertyPage() {
  const { isTablet } = useLayoutShape();
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  const branches = useApiQuery<{ branches: Branch[] }>('/api/property/branches');
  const active = selectedBranch ?? branches.data?.branches[0]?.id ?? null;

  return (
    <AppShell title="Property" subtitle="Branches, floors and rooms">
      {branches.loading ? <Loading /> : null}
      {branches.error ? (
        <ErrorState message={branches.error.message} onRetry={branches.reload} />
      ) : null}

      {branches.data ? (
        isTablet ? (
          // Two-pane on tablets: the list stays visible while a branch is open.
          <div className="grid grid-cols-[minmax(240px,1fr)_2fr] gap-4 lg:grid-cols-[minmax(280px,1fr)_3fr]">
            <div>
              <SectionHeading title="Branches" />
              <BranchList
                branches={branches.data.branches}
                selectedId={active}
                onSelect={setSelectedBranch}
              />
            </div>
            <div>{active ? <BranchDetail branchId={active} /> : null}</div>
          </div>
        ) : (
          // Single column on phones, with the selected branch expanded below.
          <div className="space-y-4">
            <BranchList
              branches={branches.data.branches}
              selectedId={active}
              onSelect={setSelectedBranch}
            />
            {active ? <BranchDetail branchId={active} /> : null}
          </div>
        )
      ) : null}
    </AppShell>
  );
}

function BranchList({
  branches, selectedId, onSelect,
}: {
  branches: Branch[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  if (branches.length === 0) {
    return <EmptyState title="No branches yet" message="An admin can add the first branch." />;
  }

  return (
    <ul className="space-y-2">
      {branches.map((branch) => (
        <li key={branch.id}>
          <button
            onClick={() => onSelect(branch.id)}
            className={cx(
              'w-full rounded-xl border p-3 text-left transition sm:p-4',
              branch.id === selectedId
                ? 'border-brand bg-brand/5'
                : 'border-border bg-surface-raised hover:bg-surface-sunken',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{branch.name}</p>
                <p className="truncate text-xs text-content-muted">
                  {branch.city ?? branch.code}
                </p>
              </div>
              {branch.status !== 'active' ? <Badge tone="caution">{branch.status}</Badge> : null}
            </div>
            <p className="mt-2 text-sm text-content-muted">
              {branch.floor_count} floor{branch.floor_count === 1 ? '' : 's'} ·{' '}
              {branch.room_count} room{branch.room_count === 1 ? '' : 's'} ·{' '}
              {branch.bed_count} bed{branch.bed_count === 1 ? '' : 's'}
            </p>
          </button>
        </li>
      ))}
    </ul>
  );
}

function BranchDetail({ branchId }: { branchId: string }) {
  const { data, error, loading, reload } = useApiQuery<{
    branch: Branch; floors: Floor[];
  }>(`/api/property/branches/${branchId}/tree`);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <SectionHeading
        title={data.branch.name}
        subtitle={`${data.floors.length} floor${data.floors.length === 1 ? '' : 's'}`}
      />

      {data.floors.length === 0 ? (
        <EmptyState
          title="No floors yet"
          message="Add floors and rooms to this branch to start placing tenants."
        />
      ) : (
        data.floors.map((floor) => (
          <section key={floor.id}>
            <h3 className="mb-2 text-sm font-semibold text-content-muted">{floor.name}</h3>
            {floor.rooms.length === 0 ? (
              <Card>
                <p className="text-sm text-content-muted">
                  No rooms configured on this floor yet.
                </p>
              </Card>
            ) : (
              // One column on small phones, widening to four across on a large
              // tablet so a whole floor is visible without scrolling.
              <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {floor.rooms.map((room) => (
                  <RoomCard key={room.id} room={room} />
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}

function RoomCard({ room }: { room: Room }) {
  const full = room.vacant_count === 0;

  return (
    <Link href={`/tenants?roomId=${room.id}`}>
      <Card className="h-full transition hover:border-brand/50">
        <div className="flex items-start justify-between gap-2">
          <p className="font-medium">{room.code}</p>
          <Badge tone={full ? 'neutral' : 'positive'}>
            {full ? 'Full' : `${room.vacant_count} free`}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-content-muted">{room.sharing_capacity} sharing</p>

        {/* A row of pips reads faster than a fraction on a small screen. */}
        <div className="mt-3 flex flex-wrap gap-1" aria-hidden>
          {Array.from({ length: room.sharing_capacity }, (_, index) => (
            <span
              key={index}
              className={cx(
                'h-2 w-5 rounded-full',
                index < room.occupied_count ? 'bg-brand' : 'bg-border',
              )}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-content-muted">
          {room.occupied_count} of {room.sharing_capacity} occupied
          {room.meter_code ? ` · meter ${room.meter_code}` : ''}
        </p>
      </Card>
    </Link>
  );
}
