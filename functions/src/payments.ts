/**
 * Payments, using Razorpay by default.
 *
 * All gateway-specific code lives in this file. To switch to Cashfree,
 * PhonePe, Paytm or PayU, replace gatewayRequest(), createPaymentOrder,
 * verifyPayment, refundPayment and the webhook parser; nothing else changes.
 *
 * Customers still pay with Google Pay, PhonePe, Paytm, any UPI app or a card:
 * the gateway's checkout screen lists them all.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { defineSecret } from "firebase-functions/params";
import { onCall, onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { db, HttpsError, now, requireRole, text } from "./shared";

// Set with: firebase functions:secrets:set RAZORPAY_KEY_ID  (and the others)
export const GATEWAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
export const GATEWAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");
export const GATEWAY_WEBHOOK_SECRET = defineSecret("RAZORPAY_WEBHOOK_SECRET");
export const gatewaySecrets = [GATEWAY_KEY_ID, GATEWAY_KEY_SECRET];

const API = "https://api.razorpay.com/v1";

async function gatewayRequest(path: string, body: unknown): Promise<Record<string, unknown>> {
  const auth = Buffer.from(`${GATEWAY_KEY_ID.value()}:${GATEWAY_KEY_SECRET.value()}`).toString("base64");
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    logger.error("Payment gateway error", { path, status: res.status, json });
    throw new HttpsError("unavailable", "The payment service had a problem. Please try again.");
  }
  return json;
}

function sameHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const rupeesToPaise = (r: number) => Math.round(r * 100);

/** Refunds a captured payment in full. Callers must list gatewaySecrets. */
export async function refundPayment(paymentId: string, amountRupees: number): Promise<void> {
  await gatewayRequest(`/payments/${paymentId}/refund`, { amount: rupeesToPaise(amountRupees) });
}

/**
 * Marks a booking as paid. Safe to call twice (from the app and from the
 * webhook). A payment that arrives after the booking expired or was cancelled
 * is flagged "paid_after_cancel" so an admin refunds it.
 */
export async function markPaid(bookingId: string, orderId: string, paymentId: string): Promise<void> {
  const ref = db.doc(`bookings/${bookingId}`);
  await db.runTransaction(async (tx) => {
    const b = await tx.get(ref);
    if (!b.exists) return;
    if (b.get("paymentOrderId") !== orderId) {
      logger.warn("Order does not match booking", { bookingId, orderId });
      return;
    }
    if (["paid", "paid_after_cancel", "refunded"].includes(b.get("paymentStatus"))) return;
    const update: Record<string, unknown> = { paymentId, paidAt: now(), updatedAt: now() };
    if (b.get("status") === "awaiting_payment") {
      update.status = "searching";
      update.paymentStatus = "paid";
    } else {
      update.paymentStatus = "paid_after_cancel";
    }
    tx.update(ref, update);
  });
}

/** Step 1 of an online payment: the app asks for an order, then opens checkout. */
export const createPaymentOrder = onCall({ secrets: gatewaySecrets }, async (req) => {
  const uid = requireRole(req, "customer");
  const id = text(req.data?.bookingId, "Booking", 20);
  const ref = db.doc(`bookings/${id}`);
  const b = await ref.get();
  if (!b.exists || b.get("customerId") !== uid) throw new HttpsError("not-found", "Booking not found.");
  if (b.get("status") !== "awaiting_payment") {
    throw new HttpsError("failed-precondition", "This booking doesn't need a payment.");
  }
  const amount = rupeesToPaise(b.get("price"));
  let orderId = b.get("paymentOrderId") as string | null;
  if (!orderId) {
    const order = await gatewayRequest("/orders", {
      amount,
      currency: "INR",
      receipt: id,
      notes: { bookingId: id },
    });
    orderId = String(order.id);
    await ref.update({ paymentOrderId: orderId, updatedAt: now() });
  }
  return { bookingId: id, orderId, amount, currency: "INR", keyId: GATEWAY_KEY_ID.value() };
});

/**
 * Step 2 (fast path): after checkout succeeds the app sends the signature so
 * the booking updates at once. The webhook below confirms it independently.
 */
export const verifyPayment = onCall({ secrets: gatewaySecrets }, async (req) => {
  const uid = requireRole(req, "customer");
  const id = text(req.data?.bookingId, "Booking", 20);
  const orderId = text(req.data?.orderId, "Order", 64);
  const paymentId = text(req.data?.paymentId, "Payment", 64);
  const signature = text(req.data?.signature, "Signature", 256);
  const expected = createHmac("sha256", GATEWAY_KEY_SECRET.value())
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  if (!sameHex(expected, signature)) {
    throw new HttpsError("permission-denied", "We couldn't verify this payment.");
  }
  const b = await db.doc(`bookings/${id}`).get();
  if (!b.exists || b.get("customerId") !== uid) throw new HttpsError("not-found", "Booking not found.");
  await markPaid(id, orderId, paymentId);
  return { ok: true };
});

/**
 * The source of truth for payments. In the gateway dashboard, point a webhook
 * at this function's URL with the events payment.captured and order.paid.
 */
export const paymentWebhook = onRequest({ secrets: [GATEWAY_WEBHOOK_SECRET] }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }
  const signature = req.get("x-razorpay-signature") ?? "";
  const expected = createHmac("sha256", GATEWAY_WEBHOOK_SECRET.value()).update(req.rawBody).digest("hex");
  if (!sameHex(expected, signature)) {
    res.status(401).send("Bad signature");
    return;
  }
  const event = req.body?.event;
  if (event === "payment.captured" || event === "order.paid") {
    const payment = req.body?.payload?.payment?.entity;
    if (payment?.order_id && payment?.id) {
      const q = await db.collection("bookings").where("paymentOrderId", "==", payment.order_id).limit(1).get();
      if (q.empty) logger.warn("Webhook for unknown order", { orderId: payment.order_id });
      else await markPaid(q.docs[0].id, payment.order_id, payment.id);
    }
  }
  res.status(200).send("ok");
});
