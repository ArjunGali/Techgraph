import type { IsoDate } from './dates.js';
import type { Paise } from './money.js';

/**
 * One continuous occupancy of one room by one tenant, as recorded in
 * `tenant_stays`. The engine only ever reads these; it never infers occupancy
 * from a tenant's "current room" field, because that would lose history.
 */
export type StaySegment = {
  stayId: string;
  tenantId: string;
  tenantName: string;
  roomId: string;
  roomCode: string;
  /** Meter that bills this room. Segments on different meters are apportioned separately. */
  meterId: string | null;
  sharingCapacity: number;
  monthlyRentPaise: Paise;
  startDate: IsoDate;
  /** Inclusive last day of the stay; null while the tenant is still in the room. */
  endDate: IsoDate | null;
};

/** A stay segment clipped to the billing month, with its day count. */
export type OccupancySegment = {
  stayId: string;
  tenantId: string;
  tenantName: string;
  roomId: string;
  roomCode: string;
  meterId: string | null;
  sharingCapacity: number;
  monthlyRentPaise: Paise;
  /** First day of the segment inside the billing month. */
  from: IsoDate;
  /** Last day of the segment inside the billing month. */
  to: IsoDate;
  /** Inclusive day count — both `from` and `to` count. */
  days: number;
};

/** Every day one tenant occupied space billed by one meter during the month. */
export type TenantOccupancy = {
  tenantId: string;
  tenantName: string;
  days: number;
  segments: OccupancySegment[];
};

export type EngineVersion = string;
