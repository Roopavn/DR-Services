import { onCall } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import {
  db, FieldValue, HttpsError, now, requireAuth, requireRole, text, SKILLS, ACTIVE_STATUSES, MAX_CODE_ATTEMPTS,
} from "./shared";

/**
 * Called after phone OTP login in the partner app. Creates a pending partner
 * record; an admin approves it after ID and police checks. ID documents are
 * uploaded by the app to Storage at workers/{uid}/docs/.
 */
export const applyAsPartner = onCall(async (req) => {
  const uid = requireAuth(req);
  const name = text(req.data?.name, "Name", 80);
  const skill = text(req.data?.skill, "Service", 20);
  if (!SKILLS.includes(skill)) throw new HttpsError("invalid-argument", "Choose cleaning, cooking or driving.");
  const raw = Array.isArray(req.data?.languages) ? req.data.languages : [];
  const languages = raw
    .filter((l: unknown): l is string => typeof l === "string" && l.trim().length > 0)
    .map((l: string) => l.trim().slice(0, 30))
    .slice(0, 6);

  const current = req.auth?.token.role as string | undefined;
  if (current && current !== "worker") {
    throw new HttpsError("failed-precondition", "This phone number is already registered as a customer.");
  }
  const wref = db.doc(`workers/${uid}`);
  if ((await wref.get()).exists) throw new HttpsError("already-exists", "You've already applied.");

  const phone = req.auth?.token.phone_number ?? null;
  await db.batch()
    .set(wref, {
      name, phone, skill, languages,
      status: "pending", online: false,
      rating: 0, ratingCount: 0, jobs: 0,
      fcmToken: null, createdAt: now(),
    })
    .set(db.doc(`users/${uid}`), { name, phone, role: "worker", createdAt: now() }, { merge: true })
    .commit();
  if (!current) await getAuth().setCustomUserClaims(uid, { role: "worker" });
  return { status: "pending", refreshToken: !current };
});

/**
 * Accept a job request. Runs in a transaction so two workers tapping
 * "Accept" at the same moment can't both get the job.
 */
export const acceptJob = onCall(async (req) => {
  const uid = requireRole(req, "worker");
  const id = text(req.data?.bookingId, "Booking", 20);
  const wref = db.doc(`workers/${uid}`);
  const ref = db.doc(`bookings/${id}`);
  const activeQuery = db.collection("bookings")
    .where("workerId", "==", uid)
    .where("status", "in", ACTIVE_STATUSES)
    .limit(1);

  await db.runTransaction(async (tx) => {
    const [w, b, active] = await Promise.all([tx.get(wref), tx.get(ref), tx.get(activeQuery)]);
    if (!w.exists || w.get("status") !== "verified") {
      throw new HttpsError("permission-denied", "Your account isn't verified yet.");
    }
    if (!w.get("online")) throw new HttpsError("failed-precondition", "Go online to accept jobs.");
    if (!active.empty) {
      throw new HttpsError("failed-precondition", "Finish your current job before accepting another.");
    }
    if (!b.exists || b.get("status") !== "searching") {
      throw new HttpsError("failed-precondition", "This job was already taken.");
    }
    if (b.get("serviceId") !== w.get("skill")) {
      throw new HttpsError("permission-denied", "This job is for a different service.");
    }
    tx.update(ref, {
      status: "assigned",
      workerId: uid,
      workerName: w.get("name"),
      workerRating: w.get("rating") ?? 0,
      workerJobs: w.get("jobs") ?? 0,
      assignedAt: now(),
      updatedAt: now(),
    });
  });
  return { ok: true };
});

/** Hide a request from this worker; it stays open for others. */
export const declineJob = onCall(async (req) => {
  const uid = requireRole(req, "worker");
  const id = text(req.data?.bookingId, "Booking", 20);
  const ref = db.doc(`bookings/${id}`);
  const b = await ref.get();
  if (b.exists && b.get("status") === "searching") {
    await ref.update({ declinedBy: FieldValue.arrayUnion(uid) });
  }
  return { ok: true };
});

/**
 * Checks a door code on the server. Workers never see the codes; the
 * customer reads them out at the door. After 5 wrong tries the job is locked
 * until support helps.
 */
async function useDoorCode(uid: string, id: string, code: string, kind: "start" | "end") {
  if (!/^\d{4}$/.test(code)) throw new HttpsError("invalid-argument", "Enter the 4-digit code.");
  const ref = db.doc(`bookings/${id}`);
  const codesRef = ref.collection("private").doc("codes");
  const wref = db.doc(`workers/${uid}`);

  const ok = await db.runTransaction(async (tx) => {
    const [b, codes] = await Promise.all([tx.get(ref), tx.get(codesRef)]);
    if (!b.exists || b.get("workerId") !== uid) throw new HttpsError("not-found", "Job not found.");
    const needed = kind === "start" ? "assigned" : "started";
    if (b.get("status") !== needed) throw new HttpsError("failed-precondition", "This job isn't ready for that step.");
    const attempts = (b.get("codeAttempts") as number | undefined) ?? 0;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      throw new HttpsError("resource-exhausted", "Too many wrong codes. Please call support.");
    }
    if (codes.get(kind) !== code) {
      tx.update(ref, { codeAttempts: attempts + 1 });
      return false;
    }
    if (kind === "start") {
      tx.update(ref, { status: "started", startedAt: now(), codeAttempts: 0, updatedAt: now() });
    } else {
      tx.update(ref, { status: "completed", completedAt: now(), codeAttempts: 0, updatedAt: now() });
      tx.update(wref, { jobs: FieldValue.increment(1) });
    }
    return true;
  });

  if (!ok) {
    throw new HttpsError("invalid-argument", "That code doesn't match. Ask the customer to check their app.");
  }
}

export const startJob = onCall(async (req) => {
  const uid = requireRole(req, "worker");
  await useDoorCode(uid, text(req.data?.bookingId, "Booking", 20), String(req.data?.code ?? ""), "start");
  return { status: "started" };
});

export const finishJob = onCall(async (req) => {
  const uid = requireRole(req, "worker");
  await useDoorCode(uid, text(req.data?.bookingId, "Booking", 20), String(req.data?.code ?? ""), "end");
  return { status: "completed" };
});
