import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { db, HttpsError, now, requireRole, text, ACTIVE_STATUSES, ServiceOption } from "./shared";
import { refundPayment, gatewaySecrets } from "./payments";

/** Manually give a waiting booking to a verified worker of the right skill. */
export const assignWorker = onCall(async (req) => {
  requireRole(req, "admin");
  const id = text(req.data?.bookingId, "Booking", 20);
  const workerId = text(req.data?.workerId, "Worker", 128);
  const ref = db.doc(`bookings/${id}`);
  const wref = db.doc(`workers/${workerId}`);
  const activeQuery = db.collection("bookings")
    .where("workerId", "==", workerId)
    .where("status", "in", ACTIVE_STATUSES)
    .limit(1);

  await db.runTransaction(async (tx) => {
    const [b, w, active] = await Promise.all([tx.get(ref), tx.get(wref), tx.get(activeQuery)]);
    if (!b.exists || b.get("status") !== "searching") {
      throw new HttpsError("failed-precondition", "Only bookings still looking for a worker can be assigned.");
    }
    if (!w.exists || w.get("status") !== "verified") throw new HttpsError("failed-precondition", "That partner isn't verified.");
    if (w.get("skill") !== b.get("serviceId")) throw new HttpsError("failed-precondition", "That partner does a different service.");
    if (!active.empty) throw new HttpsError("failed-precondition", "That partner is busy with another job.");
    tx.update(ref, {
      status: "assigned",
      workerId,
      workerName: w.get("name"),
      workerRating: w.get("rating") ?? 0,
      workerJobs: w.get("jobs") ?? 0,
      assignedAt: now(),
      assignedBy: req.auth!.uid,
      updatedAt: now(),
    });
  });
  return { ok: true };
});

/** Full refund of an online payment. Cash bookings are settled offline. */
export const refundBooking = onCall({ secrets: gatewaySecrets }, async (req) => {
  requireRole(req, "admin");
  const id = text(req.data?.bookingId, "Booking", 20);
  const ref = db.doc(`bookings/${id}`);
  const b = await ref.get();
  if (!b.exists) throw new HttpsError("not-found", "Booking not found.");
  if (b.get("payMethod") === "cash") {
    throw new HttpsError("failed-precondition", "Cash bookings are settled offline.");
  }
  if (!["paid", "paid_after_cancel", "refund_failed"].includes(b.get("paymentStatus")) || !b.get("paymentId")) {
    throw new HttpsError("failed-precondition", "There's no captured payment to refund.");
  }
  if (b.get("payoutId")) {
    logger.warn("Refunding a booking already in a payout; adjust the worker manually", { id });
  }
  await refundPayment(b.get("paymentId"), b.get("price"));
  await ref.update({
    status: "refunded",
    paymentStatus: "refunded",
    refundedAt: now(),
    refundedBy: req.auth!.uid,
    updatedAt: now(),
  });
  return { ok: true };
});

/** Approve, suspend or reinstate a partner. */
export const setWorkerStatus = onCall(async (req) => {
  requireRole(req, "admin");
  const workerId = text(req.data?.workerId, "Worker", 128);
  const status = text(req.data?.status, "Status", 20);
  if (!["verified", "suspended"].includes(status)) {
    throw new HttpsError("invalid-argument", "Status must be verified or suspended.");
  }
  const wref = db.doc(`workers/${workerId}`);
  if (!(await wref.get()).exists) throw new HttpsError("not-found", "Partner not found.");
  await wref.update({
    status,
    ...(status === "suspended" ? { online: false } : {}),
    statusChangedAt: now(),
    statusChangedBy: req.auth!.uid,
  });
  return { ok: true };
});

export const resolveComplaint = onCall(async (req) => {
  requireRole(req, "admin");
  const id = text(req.data?.complaintId, "Complaint", 40);
  const note = typeof req.data?.note === "string" ? req.data.note.trim().slice(0, 1000) : "";
  const ref = db.doc(`complaints/${id}`);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "Complaint not found.");
  await ref.update({ status: "resolved", resolution: note, resolvedAt: now(), resolvedBy: req.auth!.uid });
  return { ok: true };
});

/**
 * Update commission, welfare fee and package prices in one go.
 * prices: { [optionId]: rupees }. Only bookings made afterwards use new prices.
 */
export const updatePricing = onCall(async (req) => {
  requireRole(req, "admin");
  const commissionPct = Number(req.data?.commissionPct);
  const welfarePct = Number(req.data?.welfarePct);
  const prices = (req.data?.prices ?? {}) as Record<string, unknown>;
  if (!(commissionPct >= 0 && commissionPct <= 50)) throw new HttpsError("invalid-argument", "Commission must be 0 to 50%.");
  if (!(welfarePct >= 0 && welfarePct <= 5)) throw new HttpsError("invalid-argument", "Welfare fee must be 0 to 5%.");
  for (const [k, v] of Object.entries(prices)) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw new HttpsError("invalid-argument", `Price for ${k} must be ₹1 to ₹1,00,000.`);
  }

  await db.runTransaction(async (tx) => {
    const services = await tx.get(db.collection("services"));
    tx.set(db.doc("settings/platform"), { commissionPct, welfarePct, updatedAt: now() }, { merge: true });
    for (const s of services.docs) {
      const options = (s.get("options") ?? []) as ServiceOption[];
      let changed = false;
      const updated = options.map((o) => {
        if (prices[o.id] === undefined) return o;
        changed = true;
        return { ...o, price: Number(prices[o.id]) };
      });
      if (changed) tx.update(s.ref, { options: updated, updatedAt: now() });
    }
  });
  return { ok: true };
});

/** Record that a weekly payout was transferred (with the bank/UPI reference). */
export const markPayoutPaid = onCall(async (req) => {
  requireRole(req, "admin");
  const id = text(req.data?.payoutId, "Payout", 200);
  const reference = text(req.data?.reference, "Reference", 100);
  const ref = db.doc(`payouts/${id}`);
  const p = await ref.get();
  if (!p.exists) throw new HttpsError("not-found", "Payout not found.");
  if (p.get("status") !== "ready") throw new HttpsError("failed-precondition", "Only payouts marked ready can be paid.");
  await ref.update({ status: "paid", reference, paidAt: now(), paidBy: req.auth!.uid });
  return { ok: true };
});
