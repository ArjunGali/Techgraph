/**
 * The seed configuration.
 *
 * This describes the business as it exists today. Nothing here is referenced
 * by application code — the app reads its structure from the database — so
 * adding a floor or a room later is an admin action, not a code change.
 */

export type RoomSeed = {
  code: string;
  sharingCapacity: number;
  name?: string;
};

export type FloorSeed = {
  code: string;
  name: string;
  sortOrder: number;
  meterCode?: string;
  rooms: RoomSeed[];
};

export type BranchSeed = {
  code: string;
  name: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  pincode?: string;
  contactName?: string;
  contactPhone?: string;
  floors: FloorSeed[];
};

/**
 * Ekkatuthangal: 9 rooms across two floors, 30 beds in total.
 *
 *   Ground floor — one 6-sharing, one 5-sharing, two 3-sharing, one 1-sharing
 *   First floor  — one 5-sharing, one 4-sharing, one 3-sharing, one 1-sharing
 *
 * Each floor has its own electricity meter, so the apportionment splits that
 * floor's units across the tenants who were actually on it.
 *
 * Note on the bed total: the room list below is exactly as specified — one
 * 6-sharing, two 5-sharing, one 4-sharing, three 3-sharing and two 1-sharing,
 * nine rooms in all. Those capacities add up to 31 beds, while the
 * specification's summary line states 30. The per-room figures are given twice
 * in the specification and agree with each other, so they are taken as
 * authoritative and the summary total as the slip. Nothing here is fixed in
 * code: if a room really is one bed smaller, an admin can correct its capacity
 * in the app without a code change.
 */
export const EKKATUTHANGAL: BranchSeed = {
  code: 'EKT',
  name: 'Ekkatuthangal',
  addressLine1: 'Ekkatuthangal',
  city: 'Chennai',
  state: 'Tamil Nadu',
  pincode: '600032',
  floors: [
    {
      code: 'GF',
      name: 'Ground Floor',
      sortOrder: 0,
      meterCode: 'EKT-MTR-GF',
      rooms: [
        { code: 'GF-6S-01', sharingCapacity: 6 },
        { code: 'GF-5S-01', sharingCapacity: 5 },
        { code: 'GF-3S-01', sharingCapacity: 3 },
        { code: 'GF-3S-02', sharingCapacity: 3 },
        { code: 'GF-1S-01', sharingCapacity: 1 },
      ],
    },
    {
      code: 'F1',
      name: 'First Floor',
      sortOrder: 1,
      meterCode: 'EKT-MTR-F1',
      rooms: [
        { code: 'F1-5S-01', sharingCapacity: 5 },
        { code: 'F1-4S-01', sharingCapacity: 4 },
        { code: 'F1-3S-01', sharingCapacity: 3 },
        { code: 'F1-1S-01', sharingCapacity: 1 },
      ],
    },
  ],
};

/**
 * Alandur: the building's three floors and terrace are created so the branch
 * can be navigated, but no rooms are assumed. The admin adds rooms and their
 * sharing capacities through the app once the layout is confirmed.
 */
export const ALANDUR: BranchSeed = {
  code: 'ALD',
  name: 'Alandur',
  city: 'Chennai',
  state: 'Tamil Nadu',
  floors: [
    { code: 'GF', name: 'Ground Floor', sortOrder: 0, meterCode: 'ALD-MTR-GF', rooms: [] },
    { code: 'F1', name: 'First Floor', sortOrder: 1, meterCode: 'ALD-MTR-F1', rooms: [] },
    { code: 'F2', name: 'Second Floor', sortOrder: 2, meterCode: 'ALD-MTR-F2', rooms: [] },
    { code: 'TR', name: 'Terrace', sortOrder: 3, rooms: [] },
  ],
};

export const BRANCHES = [EKKATUTHANGAL, ALANDUR];

/** Opening rent by sharing size, in paise. Effective-dated on insert. */
export const SHARING_PRICES: { sharingCapacity: number; monthlyRentPaise: number }[] = [
  { sharingCapacity: 1, monthlyRentPaise: 1_200_000 }, // ₹12,000
  { sharingCapacity: 3, monthlyRentPaise: 800_000 }, //  ₹8,000
  { sharingCapacity: 4, monthlyRentPaise: 750_000 }, //  ₹7,500
  { sharingCapacity: 5, monthlyRentPaise: 700_000 }, //  ₹7,000
  { sharingCapacity: 6, monthlyRentPaise: 600_000 }, //  ₹6,000
];

/** The administered rates named in the specification. */
export const EB_RATE_PAISE = 1_250; // ₹12.50 per unit
export const COMMON_CHARGE_PAISE = 15_000; // ₹150 per tenant per month

export const MESSAGE_TEMPLATES = [
  {
    code: 'monthly_bill',
    name: 'Monthly bill',
    body: `Hello {{tenantName}},

Your bill for {{periodMonth}}:
Rent: {{rent}}
Electricity: {{eb}}
Common charge: {{commonCharge}}{{otherLine}}{{previousDuesLine}}
Total payable: {{total}}

{{paymentLine}}

Please share the payment screenshot once paid. Thank you.`,
  },
  {
    code: 'reminder_friendly',
    name: 'Friendly reminder',
    body:
      'Hello {{tenantName}}, a gentle reminder that {{outstanding}} is pending for ' +
      '{{periodMonth}}. Please share the payment screenshot once done. Thank you.',
  },
  {
    code: 'reminder_due',
    name: 'Payment due',
    body:
      'Hello {{tenantName}}, your payment of {{outstanding}} for {{periodMonth}} is now due. ' +
      'Please complete it at your earliest convenience.',
  },
  {
    code: 'reminder_overdue',
    name: 'Overdue notice',
    body:
      'Hello {{tenantName}}, {{outstanding}} for {{periodMonth}} is overdue. ' +
      'Please clear the balance or let us know if there is a problem.',
  },
];

/** The reminder ladder from the specification: bill on the 1st, then nudges. */
export const REMINDER_RULES = [
  { dayOfMonth: 3, templateCode: 'reminder_friendly', label: 'Friendly reminder' },
  { dayOfMonth: 5, templateCode: 'reminder_due', label: 'Payment due' },
  { dayOfMonth: 7, templateCode: 'reminder_overdue', label: 'Overdue notice' },
];

export const AUTOMATION_JOBS = [
  {
    code: 'generate_monthly_bills',
    name: 'Generate monthly bills',
    description: 'Calculates every tenant bill for the current month from stay history and meter readings.',
    scheduleCron: '0 6 1 * *',
  },
  {
    code: 'send_monthly_bills',
    name: 'Send monthly bill messages',
    description: 'Sends each tenant their bill and payment request.',
    scheduleCron: '0 9 1 * *',
  },
  {
    code: 'send_payment_reminders',
    name: 'Send payment reminders',
    description: 'Sends whichever reminder is configured for today, to tenants who still owe money.',
    scheduleCron: '0 10 * * *',
  },
  {
    code: 'remind_meter_readings',
    name: 'Meter reading reminder',
    description: 'Reports meters with no reading yet for the current month.',
    scheduleCron: '0 8 26 * *',
  },
  {
    code: 'upcoming_vacancy_alert',
    name: 'Upcoming vacancy alert',
    description: 'Lists beds coming free in the next 30 days.',
    scheduleCron: '0 8 * * 1',
  },
  {
    code: 'retry_failed_messages',
    name: 'Retry failed messages',
    description: 'Re-attempts messages the provider rejected.',
    scheduleCron: '30 * * * *',
  },
  {
    code: 'daily_summary',
    name: 'Daily summary',
    description: 'A once-a-day snapshot of approvals, overdue bills, vacancies and open issues.',
    scheduleCron: '0 20 * * *',
  },
];
