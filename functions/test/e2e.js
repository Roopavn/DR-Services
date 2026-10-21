/**
 * End-to-end test against the Firebase emulators.
 * Run from the project root:
 *   firebase emulators:exec --project demo-mane --only auth,firestore,functions "node functions/test/e2e.js"
 */
const crypto = require("crypto");
const { execSync } = require("child_process");
const P = process.env.GCLOUD_PROJECT || "demo-mane";
process.env.GCLOUD_PROJECT = P;
const AUTH = "http://127.0.0.1:9099", FS = "http://127.0.0.1:8080", FN = `http://127.0.0.1:5001/${P}/asia-south1`;
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
initializeApp({ projectId: P }, "test");
const adminAuth = getAuth(require("firebase-admin/app").getApp("test"));
const adminDb = getFirestore(require("firebase-admin/app").getApp("test"));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓", msg); } else { fail++; console.log("  ✗", msg); } };

async function signUp(email) {
  const r = await (await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=x`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", returnSecureToken: true }) })).json();
  return { uid: r.localId, token: r.idToken, refresh: r.refreshToken };
}
async function refresh(u) {
  const r = await (await fetch(`${AUTH}/securetoken.googleapis.com/v1/token?key=x`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${u.refresh}` })).json();
  u.token = r.id_token; u.refresh = r.refresh_token;
}
async function call(u, name, data) {
  const r = await (await fetch(`${FN}/${name}`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(u ? { Authorization: `Bearer ${u.token}` } : {}) },
    body: JSON.stringify({ data }) })).json();
  return r;
}
const docUrl = (path) => `${FS}/v1/projects/${P}/databases/(default)/documents/${path}`;
async function read(u, path) { return (await fetch(docUrl(path), { headers: { Authorization: `Bearer ${u.token}` } })).status; }
async function patch(u, path, fields, mask) {
  const q = mask.map((m) => `updateMask.fieldPaths=${m}`).join("&");
  return (await fetch(`${docUrl(path)}?${q}`, { method: "PATCH",
    headers: { Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }) })).status;
}
async function query(u, filters) {
  const res = await fetch(`${FS}/v1/projects/${P}/databases/(default)/documents:runQuery`, { method: "POST",
    headers: { Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "bookings" }], where: { compositeFilter: { op: "AND",
      filters: filters.map(([f, v]) => ({ fieldFilter: { field: { fieldPath: f }, op: "EQUAL", value: { stringValue: v } } })) } } } }) });
  const j = await res.json();
  return { status: res.status, ids: Array.isArray(j) ? j.filter((x) => x.document).map((x) => x.document.name.split("/").pop()) : [] };
}
const tomorrow = () => new Date(Date.now() + 5.5 * 3600e3 + 86400e3).toISOString().slice(0, 10);

(async () => {
  execSync("node functions/scripts/seed.js", { stdio: "inherit", env: process.env });

  console.log("\nAccounts and roles");
  const cust = await signUp("priya@test.in"), w1 = await signUp("lakshmi@test.in"), w2 = await signUp("asha@test.in"), adm = await signUp("admin@test.in");
  let r = await call(cust, "completeProfile", { name: "Priya S." }); await refresh(cust);
  ok(r.result?.role === "customer", "customer profile created");
  r = await call(w1, "applyAsPartner", { name: "Lakshmi N.", skill: "clean", languages: ["Kannada", "Tamil"] }); await refresh(w1);
  ok(r.result?.status === "pending", "partner application is pending");
  await call(w2, "applyAsPartner", { name: "Asha R.", skill: "clean", languages: ["Kannada"] }); await refresh(w2);
  r = await call(cust, "applyAsPartner", { name: "Priya", skill: "clean" });
  ok(r.error?.status === "FAILED_PRECONDITION", "a customer account can't also become a partner");
  await adminAuth.setCustomUserClaims(adm.uid, { role: "admin" }); await refresh(adm);
  r = await call(w1, "acceptJob", { bookingId: "MH1001" });
  ok(r.error?.status === "PERMISSION_DENIED" || r.error?.status === "FAILED_PRECONDITION", "pending partner can't accept jobs");
  r = await call(cust, "setWorkerStatus", { workerId: w1.uid, status: "verified" });
  ok(r.error?.status === "PERMISSION_DENIED", "customer can't approve partners");
  await call(adm, "setWorkerStatus", { workerId: w1.uid, status: "verified" });
  await call(adm, "setWorkerStatus", { workerId: w2.uid, status: "verified" });
  ok((await patch(w1, `workers/${w1.uid}`, { online: { booleanValue: true } }, ["online"])) === 200, "verified partner can go online");
  await patch(w2, `workers/${w2.uid}`, { online: { booleanValue: true } }, ["online"]);
  ok((await patch(w1, `workers/${w1.uid}`, { status: { stringValue: "verified" }, jobs: { integerValue: "999" } }, ["jobs"])) === 403, "partner can't edit their own job count");

  console.log("\nBooking (cash)");
  const base = { serviceId: "clean", optionId: "clean-1bhk", date: tomorrow(), slot: "09-11", area: "Green Park", addressLine: "Flat 302, Green Park Apartments" };
  r = await call(cust, "createBooking", { ...base, slot: "03-05", payMethod: "cash" });
  ok(r.error?.status === "INVALID_ARGUMENT", "invalid time slot rejected");
  r = await call(cust, "createBooking", { ...base, price: 1, payMethod: "cash" });
  const id = r.result?.bookingId;
  ok(id === "MH1001" && r.result.amount === 1499 && r.result.status === "searching", `booking ${id} created at the database price (₹1,499), app price ignored`);
  ok((await patch(cust, `bookings/${id}`, { price: { integerValue: "1" } }, ["price"])) === 403, "customer can't edit a booking directly");

  console.log("\nSecurity rules");
  let q = await query(w1, [["status", "searching"], ["serviceId", "clean"]]);
  ok(q.status === 200 && q.ids.includes(id), "verified cleaner sees the open request");
  ok((await read(w1, `bookings/${id}/private/address`)) === 403, "full address hidden before accepting");
  ok((await read(w1, `bookings/${id}/private/codes`)) === 403, "worker can never read door codes");
  ok((await read(cust, `bookings/${id}/private/codes`)) === 200, "customer can read their door codes");

  console.log("\nAccepting (two workers tap at once)");
  const [a, b] = await Promise.all([call(w1, "acceptJob", { bookingId: id }), call(w2, "acceptJob", { bookingId: id })]);
  const winners = [a, b].filter((x) => x.result?.ok).length;
  ok(winners === 1, "exactly one worker gets the job");
  const winner = a.result?.ok ? w1 : w2, loser = a.result?.ok ? w2 : w1;
  ok((await read(winner, `bookings/${id}/private/address`)) === 200, "assigned worker can now see the address");
  ok((await read(loser, `bookings/${id}`)) === 403, "the other worker can no longer see the booking");

  console.log("\nDoor codes");
  const codes = (await adminDb.doc(`bookings/${id}/private/codes`).get()).data();
  const wrong = codes.start === "1111" ? "2222" : "1111";
  r = await call(winner, "startJob", { bookingId: id, code: wrong });
  ok(r.error?.status === "INVALID_ARGUMENT", "wrong start code rejected");
  r = await call(winner, "finishJob", { bookingId: id, code: codes.end });
  ok(r.error?.status === "FAILED_PRECONDITION", "can't finish before starting");
  r = await call(winner, "startJob", { bookingId: id, code: codes.start });
  ok(r.result?.status === "started", "correct start code starts the job");
  r = await call(winner, "finishJob", { bookingId: id, code: codes.end });
  ok(r.result?.status === "completed", "correct end code completes the job");
  r = await call(cust, "rateBooking", { bookingId: id, stars: 5 });
  ok(r.result?.ok, "customer rates 5 stars");
  r = await call(cust, "rateBooking", { bookingId: id, stars: 1 });
  ok(r.error?.status === "ALREADY_EXISTS", "can't rate twice");
  r = await call(cust, "reportProblem", { bookingId: id, text: "Kitchen tiles not cleaned." });
  ok(r.result?.ok, "customer reports a problem");
  const w = (await adminDb.doc(`workers/${winner.uid}`).get()).data();
  ok(w.jobs === 1 && w.rating === 5, "worker's jobs and rating updated");

  console.log("\nOnline payment and webhook");
  r = await call(cust, "createBooking", { ...base, slot: "14-16", payMethod: "online" });
  const id2 = r.result?.bookingId;
  ok(r.result?.status === "awaiting_payment", `${id2} waits for payment`);
  q = await query(loser, [["status", "searching"], ["serviceId", "clean"]]);
  ok(!q.ids.includes(id2), "unpaid booking isn't offered to workers");
  await adminDb.doc(`bookings/${id2}`).update({ paymentOrderId: "order_TEST123" });
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_TEST9", order_id: "order_TEST123" } } } });
  const bad = await fetch(`${FN}/paymentWebhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-signature": "forged" }, body });
  ok(bad.status === 401, "webhook with a forged signature is rejected");
  const sig = crypto.createHmac("sha256", "dummy_webhook_secret").update(body).digest("hex");
  const good = await fetch(`${FN}/paymentWebhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-signature": sig }, body });
  const b2 = (await adminDb.doc(`bookings/${id2}`).get()).data();
  ok(good.status === 200 && b2.status === "searching" && b2.paymentStatus === "paid", "signed webhook marks it paid and opens it to workers");
  await fetch(`${FN}/paymentWebhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-signature": sig }, body });
  ok((await adminDb.doc(`bookings/${id2}`).get()).get("status") === "searching", "duplicate webhook is harmless");

  console.log("\nAdmin and payouts");
  r = await call(cust, "updatePricing", { commissionPct: 0, welfarePct: 0, prices: {} });
  ok(r.error?.status === "PERMISSION_DENIED", "customer can't change prices");
  r = await call(adm, "updatePricing", { commissionPct: 20, welfarePct: 2, prices: { "clean-1bhk": 1599 } });
  const svc = (await adminDb.doc("services/clean").get()).data();
  ok(r.result?.ok && svc.options.find((o) => o.id === "clean-1bhk").price === 1599, "admin updates a price");
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const { weeklyPayouts } = require("../lib/scheduled");
  await weeklyPayouts.run({ scheduleTime: new Date().toISOString() });
  const payouts = await adminDb.collection("payouts").where("workerId", "==", winner.uid).get();
  const p = payouts.docs[0]?.data();
  ok(p && p.gross === 1499 && p.commission === 300 && p.cashCollected === 1499 && p.netPayout === -300 && p.status === "worker_owes" && p.welfareFee === 24,
    "weekly payout: cash job → worker owes ₹300 commission; platform owes ₹24 welfare fee");
  ok((await read(winner, `payouts/${payouts.docs[0]?.id}`)) === 200 && (await read(loser, `payouts/${payouts.docs[0]?.id}`)) === 403, "only that worker can see their payout");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
