import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { randomInt } from "crypto";

initializeApp();

// Run every function in Mumbai, close to users and to the Firestore database.
setGlobalOptions({ region: "asia-south1", maxInstances: 10 });

export const db = getFirestore();
export { FieldValue, Timestamp, HttpsError };

export type Role = "customer" | "worker" | "admin";

export type BookingStatus =
  | "awaiting_payment" // online payment not finished yet; workers can't see it
  | "searching" // paid (or cash); offered to verified workers of that skill
  | "assigned" // a worker accepted; customer sees them and the start code
  | "started" // worker entered the start code at the door
  | "completed" // worker entered the end code
  | "cancelled"
  | "refunded";

export const SLOTS = ["07-09", "09-11", "11-13", "14-16", "16-18", "18-20"];
export const SKILLS = ["clean", "cook", "drive"];
export const ACTIVE_STATUSES: BookingStatus[] = ["assigned", "started"];
export const MAX_CODE_ATTEMPTS = 5;
export const BOOKING_WINDOW_DAYS = 14;

export function now() {
  return FieldValue.serverTimestamp();
}

export function requireAuth(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in again.");
  return req.auth.uid;
}

export function requireRole(req: CallableRequest, role: Role): string {
  const uid = requireAuth(req);
  if (req.auth?.token.role !== role) {
    throw new HttpsError("permission-denied", "You don't have access to this action.");
  }
  return uid;
}

/** Validates a required text field and returns it trimmed. */
export function text(value: unknown, field: string, max = 200, min = 1): string {
  if (typeof value !== "string") throw new HttpsError("invalid-argument", `${field} is required.`);
  const t = value.trim();
  if (t.length < min || t.length > max) {
    throw new HttpsError("invalid-argument", `${field} must be ${min} to ${max} characters.`);
  }
  return t;
}

/** Today's date in India (YYYY-MM-DD), optionally shifted by some days. */
export function istDate(offsetDays = 0): string {
  const ms = Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** A random 4-digit door code. */
export function doorCode(): string {
  return String(randomInt(1000, 10000));
}

export interface Settings {
  commissionPct: number;
  welfarePct: number;
}

export async function getSettings(): Promise<Settings> {
  const snap = await db.doc("settings/platform").get();
  const d = snap.data() ?? {};
  return {
    commissionPct: Number(d.commissionPct ?? 20),
    welfarePct: Number(d.welfarePct ?? 2),
  };
}

/**
 * How one job's price is split. The welfare fee is paid by the platform on
 * top of the worker's payout, not deducted from it.
 */
export function split(price: number, s: Settings) {
  const commission = Math.round((price * s.commissionPct) / 100);
  const payout = price - commission;
  const welfare = Math.round((payout * s.welfarePct) / 100);
  return { commission, payout, welfare };
}

export interface ServiceOption {
  id: string;
  name: string;
  price: number;
  note?: string;
  monthly?: boolean;
  active?: boolean;
}
