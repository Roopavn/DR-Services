# Mane: home services platform (backend)

This repository holds the Firebase backend for Mane: the database rules, server
code (Cloud Functions) and setup scripts that the customer app, partner app and
admin panel all use.

| Folder / file | What it is |
| --- | --- |
| `firestore.rules` | Who can read and change what. Apps read data; all important changes go through functions. |
| `storage.rules` | Partner ID document uploads. |
| `firestore.indexes.json` | Database indexes the queries need. |
| `functions/src/` | Server code, in TypeScript. |
| `functions/scripts/` | `seed.js` (loads services and prices) and `set-admin.js` (makes a phone number an admin). |
| `functions/test/e2e.js` | End-to-end test of the whole booking flow against the emulators. |

Coming next in this repository: `customer_app/` and `partner_app/` (Flutter) and `admin_web/` (React).

---

## 1. One-time setup on your computer

1. Install **Node.js 22** and **Java 21** (Java is only for the local emulators).
2. Install the Firebase CLI: `npm install -g firebase-tools`
3. Sign in: `firebase login`
4. Install the function dependencies: `cd functions && npm install`

## 2. Run everything locally (no real data, no cost)

```bash
cp functions/.secret.local.example functions/.secret.local
cd functions && npm run build && cd ..
firebase emulators:exec --project demo-mane --only auth,firestore,functions "node functions/test/e2e.js"
```

The test signs up a customer, two cleaners and an admin, then checks the
whole flow: approval, booking, the security rules, two workers accepting at
the same moment, door codes, rating, complaints, a signed payment webhook,
price changes and the weekly payout. It should end with `0 failed`.

To click around yourself, run `firebase emulators:start --project demo-mane`
and open the Emulator UI at http://localhost:4000.

## 3. Create the real Firebase projects

1. In the [Firebase console](https://console.firebase.google.com), create two
   projects: **mane-dev** (testing) and **mane-prod** (real users). If those IDs
   are taken, use your own and update `.firebaserc`.
2. In each project:
   - Upgrade to the **Blaze** (pay-as-you-go) plan; Cloud Functions need it. Set a budget alert in Google Cloud Billing.
   - **Firestore Database** → Create database → location **asia-south1 (Mumbai)**, production mode.
   - **Storage** → Get started → same location.
   - **Authentication** → Sign-in method → enable **Phone**.
3. Connect this folder: `firebase use mane-dev`

## 4. Add the payment gateway keys

Get test keys from your gateway dashboard (Razorpay by default), then:

```bash
firebase functions:secrets:set RAZORPAY_KEY_ID
firebase functions:secrets:set RAZORPAY_KEY_SECRET
firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET
```

Use **test keys in mane-dev** and **live keys only in mane-prod**. Never put keys
in the code or in the apps.

## 5. Deploy

```bash
firebase deploy --only firestore,storage,functions
```

Then, in the gateway dashboard, add a webhook pointing to the
`paymentWebhook` URL shown after deploy, with the events `payment.captured`
and `order.paid`, and the same webhook secret as above.

## 6. Load services and create your admin account

1. In the Firebase console → Project settings → Service accounts, generate a
   private key. Save it outside this folder and never commit it.
2. Load the services and prices:
   ```bash
   cd functions
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json GCLOUD_PROJECT=mane-dev npm run seed
   ```
3. Sign in once with your phone number (in the admin panel or any app), then:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json GCLOUD_PROJECT=mane-dev npm run set-admin -- +919876543210
   ```

---

## How it works

### Collections

| Collection | Contents | Written by |
| --- | --- | --- |
| `users/{uid}` | name, phone, role, saved addresses, notification token | functions; the user can edit name, addresses, token |
| `workers/{uid}` | name, skill (clean / cook / drive), languages, status (pending / verified / suspended), online, rating, jobs | functions; a verified partner can flip `online` |
| `services/{id}` | name, packages with prices | seed script, `updatePricing` |
| `settings/platform` | commission %, welfare fee % | seed script, `updatePricing` |
| `bookings/{MH1001…}` | customer, package, price snapshot, date, slot, area, payment, status, worker, rating, payout | functions only |
| `bookings/{id}/private/address` | full address: customer, admin and the assigned worker only | functions only |
| `bookings/{id}/private/codes` | start and end door codes: customer and admin only | functions only |
| `complaints/{bookingId}` | one per booking | `reportProblem`, `resolveComplaint` |
| `payouts/{week_worker}` | weekly totals per worker | `weeklyPayouts`, `markPayoutPaid` |

### Booking statuses

`awaiting_payment` → `searching` → `assigned` → `started` → `completed`,
or `cancelled` / `refunded`. Cash bookings skip `awaiting_payment`. Unpaid
online bookings are cancelled automatically after 30 minutes.

### Functions the apps call

| App | Functions |
| --- | --- |
| Customer | `completeProfile`, `createBooking`, `createPaymentOrder`, `verifyPayment`, `cancelBooking`, `rateBooking`, `reportProblem` |
| Partner | `applyAsPartner`, `acceptJob`, `declineJob`, `startJob`, `finishJob` |
| Admin panel | `setWorkerStatus`, `assignWorker`, `refundBooking`, `resolveComplaint`, `updatePricing`, `markPayoutPaid` |
| Automatic | `paymentWebhook`, `expireUnpaidBookings` (every 15 min), `weeklyPayouts` (Mondays 6 AM IST), `onBookingStatusChange` (push notifications) |

After `completeProfile` or `applyAsPartner`, the app must refresh the ID token
(`getIdToken(true)` in Flutter) so the new role takes effect.

### Reading data in the apps

- Customer's bookings: `bookings` where `customerId == uid`, ordered by `createdAt` descending.
- Partner's job requests: `bookings` where `status == "searching"` **and** `serviceId == <their skill>`. Both filters are required by the rules; hide requests whose `declinedBy` contains the partner's uid.
- Partner's current job: `bookings` where `workerId == uid` and `status in ["assigned", "started"]`.

### Money

- Commission is taken from each job; the worker's share is the rest.
- The **gig worker welfare fee** is calculated on each worker payout and
  **paid by the platform**, not deducted from the worker. Confirm the rate and
  this treatment with your lawyer before launch.
- For **cash jobs** the worker already holds the money, so the weekly payout
  subtracts it; a negative payout means the worker owes the commission.

### Security choices

- Prices always come from the database, never from the app.
- Workers never see door codes; the server checks them, and locks a job after 5 wrong tries.
- Workers see only the area of a job until they accept it; the full address unlocks after.
- Accepting a job runs in a transaction, so two workers can't get the same job.
- Payments are confirmed by the signed gateway webhook; the app's report is only a shortcut.

## Before launch checklist

- [ ] `node functions/test/e2e.js` passes on the emulators
- [ ] Firebase App Check enabled for the apps
- [ ] Daily Firestore backups scheduled (Google Cloud console → Firestore → Backups)
- [ ] Budget alerts set in Google Cloud Billing
- [ ] Gateway switched to live keys in mane-prod only
- [ ] Privacy policy and terms published; grievance officer named
