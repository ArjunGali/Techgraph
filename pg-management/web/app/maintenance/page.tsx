'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, Loading, Select, Sheet, TextArea, TextInput,
} from '@/components/ui';
import { useApiQuery, useApiMutation } from '@/lib/useApi';
import { formatDate } from '@/lib/format';
import { useAuth, P } from '@/lib/auth';

type Issue = {
  id: string; title: string; description: string | null; priority: string; status: string;
  branch_name: string; room_code: string | null; reported_date: string;
  assigned_to_name: string | null;
};

export default function MaintenancePage() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);

  const issues = useApiQuery<{ issues: Issue[] }>('/api/operations/maintenance', {
    status: status || undefined,
  });
  const branches = useApiQuery<{ branches: { id: string; name: string }[] }>('/api/property/branches');

  const update = useApiMutation<{ ok: boolean }, { id: string; status: string }>((input) => ({
    path: `/api/operations/maintenance/${input.id}`,
    method: 'PATCH',
    body: { status: input.status },
  }));

  return (
    <AppShell
      title="Maintenance"
      actions={
        can(P.MAINTENANCE_WRITE) ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            Report issue
          </Button>
        ) : undefined
      }
    >
      <div className="mb-4 sm:max-w-xs">
        <Field label="Status">
          <Select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </Select>
        </Field>
      </div>

      {issues.loading ? <Loading /> : null}
      {issues.error ? <ErrorState message={issues.error.message} onRetry={issues.reload} /> : null}

      {issues.data ? (
        issues.data.issues.length === 0 ? (
          <EmptyState title="Nothing outstanding" message="No maintenance issues match this filter." />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {issues.data.issues.map((issue) => (
              <Card key={issue.id}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{issue.title}</p>
                  <Badge
                    tone={
                      issue.priority === 'urgent'
                        ? 'critical'
                        : issue.priority === 'high'
                          ? 'caution'
                          : 'neutral'
                    }
                  >
                    {issue.priority}
                  </Badge>
                </div>
                {issue.description ? (
                  <p className="mt-1 text-sm text-content-muted">{issue.description}</p>
                ) : null}
                <p className="mt-2 text-xs text-content-muted">
                  {issue.branch_name}
                  {issue.room_code ? ` · ${issue.room_code}` : ''} · reported{' '}
                  {formatDate(issue.reported_date)}
                </p>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <Badge tone={issue.status === 'open' ? 'caution' : 'neutral'}>
                    {issue.status.replace(/_/g, ' ')}
                  </Badge>
                  {can(P.MAINTENANCE_WRITE) && issue.status !== 'closed' ? (
                    <Select
                      className="max-w-[10rem]"
                      value={issue.status}
                      onChange={async (event) => {
                        await update.run({ id: issue.id, status: event.target.value });
                        issues.reload();
                      }}
                    >
                      <option value="open">Open</option>
                      <option value="in_progress">In progress</option>
                      <option value="resolved">Resolved</option>
                      <option value="closed">Closed</option>
                    </Select>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )
      ) : null}

      <NewIssueSheet
        open={creating}
        branches={branches.data?.branches ?? []}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          issues.reload();
        }}
      />
    </AppShell>
  );
}

function NewIssueSheet({
  open, branches, onClose, onCreated,
}: {
  open: boolean;
  branches: { id: string; name: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({ branchId: '', title: '', description: '', priority: 'medium' });
  const create = useApiMutation<{ id: string }>((input: unknown) => ({
    path: '/api/operations/maintenance',
    body: input,
  }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Report an issue"
      footer={
        <Button
          fullWidth
          disabled={!form.title || !(form.branchId || branches[0]) || create.pending}
          onClick={async () => {
            await create.run({
              branchId: form.branchId || branches[0]!.id,
              title: form.title,
              description: form.description || null,
              priority: form.priority,
            });
            setForm({ branchId: '', title: '', description: '', priority: 'medium' });
            onCreated();
          }}
        >
          {create.pending ? 'Saving…' : 'Report issue'}
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Branch">
          <Select
            value={form.branchId}
            onChange={(event) => setForm((f) => ({ ...f, branchId: event.target.value }))}
          >
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select
            value={form.priority}
            onChange={(event) => setForm((f) => ({ ...f, priority: event.target.value }))}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Title">
            <TextInput
              value={form.title}
              onChange={(event) => setForm((f) => ({ ...f, title: event.target.value }))}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Description">
            <TextArea
              value={form.description}
              onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))}
            />
          </Field>
        </div>
      </div>
      {create.error ? <p className="mt-3 text-sm text-critical">{create.error.message}</p> : null}
    </Sheet>
  );
}
