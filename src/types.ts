/** Shared types for x402-rentals. */

export interface VenueInfo {
  name: string;
  description: string;
  timezone: string;
  address: string;
  phone: string;
}

export interface DayHours {
  open: string; // "HH:MM"
  close: string; // "HH:MM"
}

export interface PeakHours {
  from: string; // "HH:MM"
  to: string; // "HH:MM"
}

export interface RentalItem {
  id: string;
  name: string;
  category: "court" | "room" | "equipment" | string;
  description: string;
  location: string;
  /** Price per block, e.g. "$0.02". */
  ratePerBlock: string;
  /** Optional higher rate inside `peakHours`. */
  peakRatePerBlock?: string;
  peakHours?: PeakHours;
  minBlocks: number;
  maxBlocks: number;
  /** What kind of code is issued on reservation. */
  accessType: "gate-code" | "door-code" | "locker-code" | string;
  terms: string;
}

export interface RentalPolicy {
  reservePrice: string;
  quotePrice: string;
  description: string;
  freeCancellationHours: number;
}

export interface InventoryConfig {
  venue: VenueInfo;
  hours: Record<string, DayHours | null>;
  bookingWindowDays: number;
  /** Length of one bookable block in minutes. */
  blockMinutes: number;
  items: RentalItem[];
  quoteValidMinutes: number;
  policy: RentalPolicy;
}

/** One booked block on an item's calendar. */
export interface BusyBlock {
  date: string; // YYYY-MM-DD
  start: string; // HH:MM
  end: string; // HH:MM
  rentalId: string;
}

export interface QuoteLine {
  block: string; // "HH:MM–HH:MM"
  rate: string;
  peak: boolean;
}

export interface Rental {
  rentalId: string;
  status: "confirmed" | "cancelled";
  itemId: string;
  itemName: string;
  date: string;
  start: string;
  end: string;
  blocks: number;
  total: string;
  accessCode: string;
  holderName: string;
  payerWallet?: string;
  cancelToken: string;
  createdAt: string;
  cancelledAt?: string;
}
