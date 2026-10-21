# DR Services — doorstep services platform

This repository is for the DR Services doorstep home-services booking platform. The backend starter supplied for this project is named **Mane Platform** and is intended to support customer bookings, service partners, administrators, Firestore security rules, and Firebase Cloud Functions.

## Current project layout

The backend archive should be extracted into `mane-platform/` so it contains:

- `firebase.json` — Firebase deployment configuration
- `firestore.rules` and `storage.rules` — database and upload rules
- `firestore.indexes.json` — Firestore indexes
- `functions/` — TypeScript Cloud Functions, tests and setup scripts

Customer mobile apps, partner mobile apps, and the admin web UI are not included in the backend archive and will be separate project components.

## Deploy with GitHub Actions

The workflow at `.github/workflows/firebase-deploy.yml` builds the Cloud Functions and deploys Firebase resources when changes are pushed to `main`.

Add these repository Actions secrets before deployment:

- `FIREBASE_TOKEN` — CI token created using Firebase CLI authentication
- `FIREBASE_PROJECT_ID` — the Firebase project ID to deploy to

**Important:** Use a dedicated Firebase project for testing first. Review Firestore/Storage rules, billing, secrets, payment webhooks, and IAM permissions before deploying to production. Never commit real API keys, payment secrets, service-account JSON files, or local secret files.

## Local build

Requirements: Node.js 22 and Firebase CLI.

```bash
cd mane-platform/functions
npm ci
npm run build
```

Run emulator tests following the instructions in `mane-platform/README.md` after the backend files have been added.
