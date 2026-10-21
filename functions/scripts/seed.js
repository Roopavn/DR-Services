/**
 * Loads the starting service catalogue and platform settings.
 * Safe to run again: it overwrites services and settings, nothing else.
 *
 * Against the emulator:   FIRESTORE_EMULATOR_HOST=localhost:8080 GCLOUD_PROJECT=mane-dev node scripts/seed.js
 * Against a real project: GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json GCLOUD_PROJECT=mane-dev node scripts/seed.js
 */
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();

// Sample prices from the prototype; change them later in the admin panel.
const services = [
  { id: "clean", name: "Home cleaning", blurb: "Deep cleans and daily maids", order: 1, options: [
    { id: "clean-1bhk", name: "1 BHK deep clean", price: 1499, note: "About 3 hours, 1 person" },
    { id: "clean-2bhk", name: "2 BHK deep clean", price: 1999, note: "About 4 hours, 2 people" },
    { id: "clean-maid", name: "Daily maid", price: 4500, note: "Sweeping, mopping, dishes, 1 hour a day", monthly: true },
  ] },
  { id: "cook", name: "Home cook", blurb: "Fresh meals cooked in your kitchen", order: 2, options: [
    { id: "cook-meal", name: "One meal visit", price: 349, note: "Lunch or dinner for up to 4, 90 minutes" },
    { id: "cook-prep", name: "Weekly meal prep", price: 999, note: "Prep for 5 days, about 3 hours" },
    { id: "cook-daily", name: "Daily cook", price: 6000, note: "Two meals a day", monthly: true },
  ] },
  { id: "drive", name: "Driver", blurb: "A verified driver for your own car", order: 3, options: [
    { id: "drive-4h", name: "Driver for 4 hours", price: 699, note: "In the city, your car" },
    { id: "drive-8h", name: "Driver for 8 hours", price: 1199, note: "In the city, your car" },
    { id: "drive-month", name: "Monthly driver", price: 18000, note: "8 hours a day, 26 days", monthly: true },
  ] },
];

(async () => {
  const batch = db.batch();
  for (const { id, ...data } of services) {
    batch.set(db.doc(`services/${id}`), { ...data, active: true, updatedAt: FieldValue.serverTimestamp() });
  }
  batch.set(db.doc("settings/platform"), { commissionPct: 20, welfarePct: 2, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
  console.log(`Seeded ${services.length} services and platform settings.`);
})().catch((e) => { console.error(e); process.exit(1); });
