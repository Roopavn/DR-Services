import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions";
import { db } from "./shared";

const SLOT_LABEL: Record<string, string> = {
  "07-09": "7–9 AM", "09-11": "9–11 AM", "11-13": "11 AM–1 PM",
  "14-16": "2–4 PM", "16-18": "4–6 PM", "18-20": "6–8 PM",
};

async function tokenAt(path: string): Promise<string[]> {
  const snap = await db.doc(path).get();
  const t = snap.get("fcmToken");
  return typeof t === "string" && t ? [t] : [];
}

async function send(tokens: string[], title: string, body: string, bookingId: string) {
  if (!tokens.length) return;
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { bookingId },
    android: { priority: "high" },
  });
  if (res.failureCount) logger.warn(`${res.failureCount} notifications failed`, { bookingId });
}

/** Push notifications whenever a booking's status changes. */
export const onBookingStatusChange = onDocumentWritten("bookings/{bookingId}", async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!after || before?.status === after.status) return;
  const id = event.params.bookingId;
  const when = `${after.date}, ${SLOT_LABEL[after.slot] ?? after.slot}`;
  const first = String(after.workerName ?? "").split(" ")[0];

  switch (after.status) {
    case "searching": {
      const workers = await db.collection("workers")
        .where("skill", "==", after.serviceId)
        .where("status", "==", "verified")
        .where("online", "==", true)
        .get();
      const declined: string[] = after.declinedBy ?? [];
      const tokens = workers.docs
        .filter((w) => !declined.includes(w.id))
        .map((w) => w.get("fcmToken"))
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      await send(tokens, "New job request", `${after.optionName} in ${after.area}, ${when}`, id);
      break;
    }
    case "assigned":
      await send(await tokenAt(`users/${after.customerId}`), "Worker assigned",
        `${first} will do your ${after.optionName}. Your start code is in the app.`, id);
      if (after.assignedBy) {
        await send(await tokenAt(`workers/${after.workerId}`), "New job assigned", `${after.optionName}, ${when}`, id);
      }
      break;
    case "started":
      await send(await tokenAt(`users/${after.customerId}`), "Job started",
        `${first} has started. Share the end code only when you're happy with the work.`, id);
      break;
    case "completed":
      await send(await tokenAt(`users/${after.customerId}`), "Job completed", `How did ${first} do? Tap to rate.`, id);
      break;
    case "cancelled":
      if (before?.status === "assigned" && after.workerId) {
        await send(await tokenAt(`workers/${after.workerId}`), "Job cancelled",
          `The customer cancelled ${after.optionName}, ${when}.`, id);
      }
      break;
  }
});
