/**
 * Makes a phone number an admin. The person must have signed in once
 * (in any of the apps or the admin panel) so their account exists.
 *
 * Usage: GOOGLE_APPLICATION_CREDENTIALS=... GCLOUD_PROJECT=mane-dev node scripts/set-admin.js +919876543210
 * (For the emulator, set FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 and FIRESTORE_EMULATOR_HOST=localhost:8080 instead.)
 */
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const phone = process.argv[2];
if (!phone || !/^\+\d{10,15}$/.test(phone)) {
  console.error("Give a phone number with country code, e.g. +919876543210");
  process.exit(1);
}
initializeApp({ projectId: process.env.GCLOUD_PROJECT });

(async () => {
  const user = await getAuth().getUserByPhoneNumber(phone);
  await getAuth().setCustomUserClaims(user.uid, { role: "admin" });
  await getFirestore().doc(`users/${user.uid}`).set(
    { phone, role: "admin", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log(`${phone} is now an admin. They must sign out and in again.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
