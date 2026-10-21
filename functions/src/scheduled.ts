import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db, Timestamp, now, getSettings, split, istDate } from "./shared";

/** Online bookings left unpaid for 30 minutes are cancelled automatically. */
export const expireUnpaidBookings = onSchedule(
  { schedule: "every 15 minutes", timeZone: "Asia/Kolkata" },
  async () => {
    const cutoff = Timestamp.fromMillis(Date.now() - 30 * 60_000);
    const q = await db.collection("bookings")
      .where("status", "==", "awaiting_payment")
      .where("createdAt", "<", cutoff)
      .limit(400)
      .get();
    const writer = db.bulkWriter();
    q.docs.forEach((d) => writer.update(d.ref, { status: "cancelled", cancelledBy: "system", updatedAt: now() }));
    await writer.close();
    if (!q.empty) logger.info(`Expired ${q.size} unpaid bookings`);
  },
);

/**
 * Every Monday 6 AM IST: one payout record per worker for all completed jobs
 * not yet paid out.
 *   netPayout = job value − commission − cash the worker already collected
 * A negative netPayout means the worker owes the platform its commission on
 * cash jobs. The welfare fee is recorded separately; the platform pays it.
 * Transfers are made from the admin panel (or RazorpayX/Cashfree Payouts)
 * and then marked paid with markPayoutPaid.
 */
export const weeklyPayouts = onSchedule(
  { schedule: "0 6 * * 1", timeZone: "Asia/Kolkata" },
  async () => {
    const settings = await getSettings();
    const q = await db.collection("bookings")
      .where("status", "==", "completed")
      .where("payoutId", "==", null)
      .get();

    const byWorker = new Map<string, QueryDocumentSnapshot[]>();
    for (const d of q.docs) {
      const w = d.get("workerId") as string | null;
      if (!w) continue;
      byWorker.set(w, [...(byWorker.get(w) ?? []), d]);
    }

    const weekOf = istDate(0);
    const writer = db.bulkWriter();
    for (const [workerId, docs] of byWorker) {
      let gross = 0, commission = 0, welfareFee = 0, cashCollected = 0;
      for (const d of docs) {
        const price = d.get("price") as number;
        const s = split(price, settings);
        gross += price;
        commission += s.commission;
        welfareFee += s.welfare;
        if (d.get("payMethod") === "cash") cashCollected += price;
      }
      const netPayout = gross - commission - cashCollected;
      const payoutId = `${weekOf}_${workerId}`;
      writer.set(db.doc(`payouts/${payoutId}`), {
        workerId,
        workerName: docs[0].get("workerName") ?? "",
        weekOf,
        bookingIds: docs.map((d) => d.id),
        jobs: docs.length,
        gross,
        commission,
        cashCollected,
        netPayout,
        welfareFee,
        commissionPct: settings.commissionPct,
        welfarePct: settings.welfarePct,
        status: netPayout > 0 ? "ready" : netPayout < 0 ? "worker_owes" : "settled",
        createdAt: now(),
      });
      docs.forEach((d) => writer.update(d.ref, { payoutId }));
    }
    await writer.close();
    logger.info(`Created ${byWorker.size} payouts for week of ${weekOf}`);
  },
);
