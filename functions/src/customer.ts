import { onCall } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions";
import {
  db, HttpsError, now, requireAuth, requireRole, text, istDate, doorCode,
  SLOTS, BOOKING_WINDOW_DAYS, ServiceOption,
} from "./shared";
import { refundPayment, gatewaySecrets } from "./payments";

/**
 * Called once after phone OTP login in the customer app. Creates the profile
 * and gives the account the "customer" role. The app must then refresh its
 * ID token (getIdToken(true)) so the new role takes effect.
 */
export const completeProfile = onCall(async (req) => {
  const uid = requireAuth(req);
  const name = text(req.data?.name, "Name", 80);
  const current = req.auth?.token.role as string | undefined;
  if (current && current !== "customer") {
    throw new HttpsError("failed-precondition", "This phone number is already registered as a partner.");
  }
  const ref = db.doc(`users/${uid}`);
  const existing = await ref.get();
  await ref.set(
    {
      name,
      phone: req.auth?.token.phone_number ?? null,
      role: "customer",
      updatedAt: now(),
      ...(existing.exists ? {} : { addresses: [], createdAt: now() }),
    },
    { merge: true },
  );
  if (!current) await getAuth().setCustomUserClaims(uid, { role: "customer" });
  return { role: "customer", refreshToken: !current };
});

/**
 * Creates a booking. The price always comes from the database, never from
 * the app. Cash bookings go straight to "searching"; online bookings wait for
 * payment (see payments.ts) and expire after 30 minutes if unpaid.
 */
export const createBooking = onCall(async (req) => {
  const uid = requireRole(req, "customer");
  const d = req.data ?? {};
  const serviceId = text(d.serviceId, "Service", 40);
  const optionId = text(d.optionId, "Package", 40);
  const date = text(d.date, "Date", 10, 10);
  const slot = text(d.slot, "Time slot", 5, 5);
  const area = text(d.area, "Area", 80, 2);
  const addressLine = text(d.addressLine, "Address", 300, 5);
  const payMethod = d.payMethod === "cash" ? "cash" : "online";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < istDate(0) || date > istDate(BOOKING_WINDOW_DAYS)) {
    throw new HttpsError("invalid-argument", `Choose a date within the next ${BOOKING_WINDOW_DAYS} days.`);
  }
  if (!SLOTS.includes(slot)) throw new HttpsError("invalid-argument", "Choose a valid time slot.");

  const [svc, user] = await Promise.all([db.doc(`services/${serviceId}`).get(), db.doc(`users/${uid}`).get()]);
  if (!svc.exists || svc.get("active") === false) {
    throw new HttpsError("not-found", "This service is not available right now.");
  }
  const options = (svc.get("options") ?? []) as ServiceOption[];
  const opt = options.find((o) => o.id === optionId && o.active !== false);
  if (!opt) throw new HttpsError("not-found", "This package is not available right now.");

  const status = payMethod === "cash" ? "searching" : "awaiting_payment";
  const counterRef = db.doc("counters/bookings");

  const bookingId = await db.runTransaction(async (tx) => {
    const counter = await tx.get(counterRef);
    const next = (counter.get("next") as number | undefined) ?? 1001;
    const id = `MH${next}`;
    const ref = db.doc(`bookings/${id}`);
    tx.set(counterRef, { next: next + 1 }, { merge: true });
    tx.set(ref, {
      customerId: uid,
      customerName: user.get("name") ?? "",
      serviceId,
      serviceName: svc.get("name") ?? serviceId,
      optionId,
      optionName: opt.name,
      monthly: Boolean(opt.monthly),
      price: opt.price,
      date,
      slot,
      area,
      payMethod,
      paymentStatus: payMethod === "cash" ? "cash_due" : "pending",
      paymentOrderId: null,
      paymentId: null,
      status,
      workerId: null,
      workerName: null,
      workerRating: null,
      declinedBy: [],
      codeAttempts: 0,
      rating: null,
      payoutId: null,
      createdAt: now(),
      updatedAt: now(),
    });
    tx.set(ref.collection("private").doc("address"), { line: addressLine, area });
    tx.set(ref.collection("private").doc("codes"), { start: doorCode(), end: doorCode() });
    return id;
  });

  return { bookingId, status, amount: opt.price, payMethod };
});

/** Customer cancels before the job starts. Online payments are refunded. */
export const cancelBooking = onCall({ secrets: gatewaySecrets }, async (req) => {
  const uid = requireRole(req, "customer");
  const id = text(req.data?.bookingId, "Booking", 20);
  const ref = db.doc(`bookings/${id}`);

  const booking = await db.runTransaction(async (tx) => {
    const b = await tx.get(ref);
    if (!b.exists || b.get("customerId") !== uid) throw new HttpsError("not-found", "Booking not found.");
    if (!["awaiting_payment", "searching", "assigned"].includes(b.get("status"))) {
      throw new HttpsError("failed-precondition", "This booking can no longer be cancelled.");
    }
    tx.update(ref, { status: "cancelled", cancelledBy: "customer", updatedAt: now() });
    return b.data()!;
  });

  if (booking.paymentStatus === "paid" && booking.paymentId) {
    try {
      await refundPayment(booking.paymentId, booking.price);
      await ref.update({ paymentStatus: "refunded", refundedAt: now() });
    } catch (e) {
      logger.error("Refund failed on cancel", { id, e });
      await ref.update({ paymentStatus: "refund_failed" });
    }
  }
  return { status: "cancelled" };
});

/** One rating per completed booking; updates the worker's average. */
export const rateBooking = onCall(async (req) => {
  const uid = requireRole(req, "customer");
  const id = text(req.data?.bookingId, "Booking", 20);
  const stars = Number(req.data?.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new HttpsError("invalid-argument", "Rating must be 1 to 5 stars.");
  }
  const ref = db.doc(`bookings/${id}`);
  await db.runTransaction(async (tx) => {
    const b = await tx.get(ref);
    if (!b.exists || b.get("customerId") !== uid) throw new HttpsError("not-found", "Booking not found.");
    if (b.get("status") !== "completed") throw new HttpsError("failed-precondition", "You can rate after the job is done.");
    if (b.get("rating") != null) throw new HttpsError("already-exists", "You've already rated this job.");
    const wref = db.doc(`workers/${b.get("workerId")}`);
    const w = await tx.get(wref);
    const count = (w.get("ratingCount") as number | undefined) ?? 0;
    const avg = (w.get("rating") as number | undefined) ?? 0;
    const newAvg = Math.round(((avg * count + stars) / (count + 1)) * 10) / 10;
    tx.update(ref, { rating: stars, updatedAt: now() });
    tx.update(wref, { rating: newAvg, ratingCount: count + 1 });
  });
  return { ok: true };
});

/** One complaint per booking, once the job has started. */
export const reportProblem = onCall(async (req) => {
  const uid = requireRole(req, "customer");
  const id = text(req.data?.bookingId, "Booking", 20);
  const message = text(req.data?.text, "Description", 1000, 5);
  const b = await db.doc(`bookings/${id}`).get();
  if (!b.exists || b.get("customerId") !== uid) throw new HttpsError("not-found", "Booking not found.");
  if (!["started", "completed", "refunded"].includes(b.get("status"))) {
    throw new HttpsError("failed-precondition", "You can report a problem once the job has started.");
  }
  try {
    await db.doc(`complaints/${id}`).create({
      bookingId: id,
      customerId: uid,
      workerId: b.get("workerId"),
      workerName: b.get("workerName"),
      optionName: b.get("optionName"),
      text: message,
      status: "open",
      createdAt: now(),
    });
  } catch {
    throw new HttpsError("already-exists", "You've already reported this booking. Our team will call you.");
  }
  return { ok: true };
});

