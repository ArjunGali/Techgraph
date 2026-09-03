'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import {
  Button, DataTable, EmptyState, ErrorState, Field, Loading, Select, Sheet, Stat, TextInput,
  type Column,
} from '@/components/ui';
import { useApiQuery, useApiMutation } from '@/lib/useApi';
import { formatDate, formatPaise, formatRupees, todayIso } from '@/lib/format';
import { useAuth, P } from '@/lib/auth';

type Expense = {
  id: string; category: string; amount_paise: number; expense_date: string;
  vendor: string | null; notes: string | null; branch_name: string;
};

const CATEGORIES = [
  'electricity', 'salary', 'repairs', 'maintenance', 'supplies', 'rent', 'internet', 'water', 'other',
];

export default function ExpensesPage() {
  const { can } = useAuth();
  const [category, setCategory] = useState('');
  const [creating, setCreating] = useState(false);

  const expenses = useApiQuery<{ expenses: Expense[]; totalPaise: number }>('/api/operations/expenses', {
    category: category || undefined,
  });
  const branches = useApiQuery<{ branches: { id: string; name: string }[] }>('/api/property/branches');

  const columns: Column<Expense>[] = [
    { key: 'category', header: 'Category', primary: true, render: (row) => row.category },
    { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatPaise(row.amount_paise) },
    { key: 'date', header: 'Date', render: (row) => formatDate(row.expense_date) },
    { key: 'branch', header: 'Branch', render: (row) => row.branch_name },
    { key: 'vendor', header: 'Vendor', wideOnly: true, render: (row) => row.vendor ?? '—' },
  ];

  return (
    <AppShell
      title="Expenses"
      actions={
        can(P.EXPENSE_WRITE) ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            Record expense
          </Button>
        ) : undefined
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="Category">
          <Select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </Field>
        {expenses.data ? (
          <Stat label="Total" value={formatRupees(expenses.data.totalPaise)} />
        ) : null}
      </div>

      {expenses.loading ? <Loading /> : null}
      {expenses.error ? <ErrorState message={expenses.error.message} onRetry={expenses.reload} /> : null}
      {expenses.data ? (
        <DataTable
          columns={columns}
          rows={expenses.data.expenses}
          keyOf={(row) => row.id}
          empty={<EmptyState title="No expenses recorded" />}
        />
      ) : null}

      <NewExpenseSheet
        open={creating}
        branches={branches.data?.branches ?? []}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          expenses.reload();
        }}
      />
    </AppShell>
  );
}

function NewExpenseSheet({
  open, branches, onClose, onCreated,
}: {
  open: boolean;
  branches: { id: string; name: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    branchId: '', category: 'electricity', amount: '', expenseDate: todayIso(), vendor: '',
  });
  const create = useApiMutation<{ id: string }>((input: unknown) => ({
    path: '/api/operations/expenses',
    body: input,
  }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Record an expense"
      footer={
        <Button
          fullWidth
          disabled={!form.amount || branches.length === 0 || create.pending}
          onClick={async () => {
            await create.run({
              branchId: form.branchId || branches[0]!.id,
              category: form.category,
              // Entered in rupees, sent as integer paise.
              amountPaise: Math.round(Number(form.amount) * 100),
              expenseDate: form.expenseDate,
              vendor: form.vendor || null,
            });
            setForm((f) => ({ ...f, amount: '', vendor: '' }));
            onCreated();
          }}
        >
          {create.pending ? 'Saving…' : 'Record expense'}
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
        <Field label="Category">
          <Select
            value={form.category}
            onChange={(event) => setForm((f) => ({ ...f, category: event.target.value }))}
          >
            {CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount (₹)">
          <TextInput
            inputMode="decimal"
            value={form.amount}
            onChange={(event) => setForm((f) => ({ ...f, amount: event.target.value }))}
          />
        </Field>
        <Field label="Date">
          <TextInput
            type="date"
            value={form.expenseDate}
            onChange={(event) => setForm((f) => ({ ...f, expenseDate: event.target.value }))}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Vendor" hint="Optional">
            <TextInput
              value={form.vendor}
              onChange={(event) => setForm((f) => ({ ...f, vendor: event.target.value }))}
            />
          </Field>
        </div>
      </div>
      {create.error ? <p className="mt-3 text-sm text-critical">{create.error.message}</p> : null}
    </Sheet>
  );
}
