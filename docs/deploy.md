# Deploying GiftFit to Google Cloud Run

This is how the live deployment is set up and released. Two Cloud Run services in one project and region:

| Service | What it serves | Source |
|---|---|---|
| `giftfit` | The app: home page, widget (`/w`, `giftfit.js`), API, recipient page, Fit Report, store-URL previews | repo root `Dockerfile` |
| `giftfit-demo-store` | The fictional demo store (Lumen & Co.), a separate origin that embeds the widget with one script tag | `server/demo-store/Dockerfile` |

State lives in **Firestore** (a named database) and a **private Cloud Storage bucket** for recipient photos. Secrets come from **Secret Manager**. **Cloud Scheduler** runs the hourly purge. Voice uses **Speech-to-Text V2** and **Text-to-Speech**.

Placeholders look like `<THIS>`. Never paste a secret value into a file, a commit, a chat or a shell history you share. The commands use bash (Git Bash works on Windows) and run from the repo root.

## 0. Before every deploy

```bash
npm run gate:full     # lint, typecheck, unit tests, build, Playwright e2e (mock mode). Must be green.
git status            # deploy a committed state
```

`gcloud run deploy --source .` uploads the working tree minus `.gcloudignore` (no `.env*`, docs, tests, real face fixtures or photo inbox). Two things are not in git but are uploaded if present, so prepare them first:

- **Live2D** (optional; without it the widget shows the SVG mascot): copy Cubism Core `live2dcubismcore.min.js` (Cubism SDK for Web 5-r.5, unmodified) to `public/live2d/core/`, then `npm run live2d:fetch` for the Mark-kun sample model and shaders.
- Nothing else: `public/voice/` (the retired in-browser voice, ADR-059) is excluded, and the `Dockerfile` fails the build if it is present.

## 1. Project, APIs, service account

```bash
export PROJECT_ID=<your-project-id>
export REGION=us-central1
export SERVICE=giftfit
export RUN_SA=giftfit-run@${PROJECT_ID}.iam.gserviceaccount.com
export DB_ID=giftfit-db
export PHOTO_BUCKET=${PROJECT_ID}-giftfit-photos

gcloud auth login
gcloud config set project "$PROJECT_ID"
gcloud config set run/region "$REGION"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com firestore.googleapis.com \
  storage.googleapis.com speech.googleapis.com texttospeech.googleapis.com iam.googleapis.com

# Runtime identity. It gets only the roles below.
gcloud iam service-accounts create giftfit-run --display-name="GiftFit Cloud Run runtime"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${RUN_SA}" --role=roles/datastore.user
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${RUN_SA}" --role=roles/speech.client
```

Text-to-Speech needs no extra role. Optional but recommended: a budget alert on the billing account.

## 2. Firestore and the photo bucket

```bash
# Named Firestore database (native mode).
gcloud firestore databases create --database="$DB_ID" --location="$REGION" --type=firestore-native

# TTL on every collection the app writes (field expiresAt). Gift links expire after 72 h,
# previews after 24 h; the TTL deletes the documents a little after that.
for c in fit_requests fit_reports recipient_profiles hearts tryons metal_wishes photo_index \
         widget_contacts preview_stores preview_page_snapshots rate_limits daily_counters audit_log; do
  gcloud firestore fields ttls update expiresAt --collection-group="$c" --database="$DB_ID" --enable-ttl --async
done

# Private bucket for recipient photos: uniform access, public access prevented, 1-day lifecycle
# delete as a backstop (the app deletes photos within 1 hour, on Done or "Delete my photo now").
gcloud storage buckets create "gs://${PHOTO_BUCKET}" --location="$REGION" \
  --uniform-bucket-level-access --public-access-prevention
cat > /tmp/lifecycle.json <<'EOF'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}
EOF
gcloud storage buckets update "gs://${PHOTO_BUCKET}" --lifecycle-file=/tmp/lifecycle.json
# Deleted photos must not linger: turn off soft delete on this bucket.
gcloud storage buckets update "gs://${PHOTO_BUCKET}" --clear-soft-delete
gcloud storage buckets add-iam-policy-binding "gs://${PHOTO_BUCKET}" \
  --member="serviceAccount:${RUN_SA}" --role=roles/storage.objectAdmin
```

## 3. Secrets (Secret Manager)

| Env var in the app | Secret name | Value |
|---|---|---|
| `YOUCAM_API_KEY` | `giftfit-youcam-api-key` | your YouCam API key |
| `ANTHROPIC_API_KEY` | `giftfit-anthropic-api-key` | your Anthropic API key |
| `GIFTFIT_URL_SIGNING_SECRET` | `giftfit-url-signing-secret` | random, 32 bytes |
| `FIT_DECOY_SECRET` | `giftfit-fit-decoy-secret` | random, 32 bytes |
| `CRON_SECRET` | `giftfit-cron-secret` | random, 24 bytes |
| `SMTP_PASS` (optional, email) | `giftfit-smtp-pass` | your SMTP password |
| `GIFTFIT_RECORDING_TOKEN` (optional, owner recording session) | `giftfit-recording-token` | random, 32 bytes |

```bash
# Keys you hold: read without echo, pipe straight in, then clear the variable.
read -rs YOUCAM_KEY && printf '%s' "$YOUCAM_KEY" | gcloud secrets create giftfit-youcam-api-key --replication-policy=automatic --data-file=- && unset YOUCAM_KEY
read -rs ANTHROPIC_KEY && printf '%s' "$ANTHROPIC_KEY" | gcloud secrets create giftfit-anthropic-api-key --replication-policy=automatic --data-file=- && unset ANTHROPIC_KEY

# Random secrets, generated and stored without being shown. Strip \r too: openssl in Git Bash
# ends its output with CRLF, and a trailing \r breaks the Scheduler's Bearer header.
openssl rand -hex 32 | tr -d '\r\n' | gcloud secrets create giftfit-url-signing-secret --replication-policy=automatic --data-file=-
openssl rand -hex 32 | tr -d '\r\n' | gcloud secrets create giftfit-fit-decoy-secret --replication-policy=automatic --data-file=-
openssl rand -hex 24 | tr -d '\r\n' | gcloud secrets create giftfit-cron-secret --replication-policy=automatic --data-file=-

for s in giftfit-youcam-api-key giftfit-anthropic-api-key giftfit-url-signing-secret giftfit-fit-decoy-secret giftfit-cron-secret; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${RUN_SA}" --role=roles/secretmanager.secretAccessor
done
```

Grant the service account access to `giftfit-smtp-pass` and `giftfit-recording-token` the same way if you create them. To rotate a secret: `... | gcloud secrets versions add <name> --data-file=-`, then redeploy so `latest` is picked up.

## 4. Environment variables

Every variable, with defaults, is documented in [`.env.example`](../.env.example). The live `giftfit` service uses:

| Variable | Live value | Why |
|---|---|---|
| `NODE_ENV` | `production` | |
| `YOUCAM_MOCK` | `0` | real YouCam client (paid calls still need `YOUCAM_ALLOW_PAID=1`) |
| `YOUCAM_ALLOW_PAID` | `0` | **the public site spends 0 units** (ADR-058) |
| `YOUCAM_MAX_UNITS_PER_RUN` / `YOUCAM_DAILY_UNIT_CAP` | `40` / `150` | cost guard, fails closed |
| `STORE` | `firestore` | durable state across instances and restarts |
| `FIRESTORE_DATABASE_ID` | `giftfit-db` | the named database from step 2 |
| `GCS_PHOTO_BUCKET` | `<project>-giftfit-photos` | the private bucket from step 2 |
| `GOOGLE_CLOUD_PROJECT` | `<project>` | Firestore and the Speech-to-Text recognizer path |
| `APP_BASE_URL` | the service's public URL | origin of every gift link and email link (the Host header is caller-controlled) |
| `GIFTFIT_WIDGET_ORIGINS` | the demo store's URLs | stores allowed to embed `/w` (frame-ancestors and postMessage allow-list) |
| `GIFTFIT_DEMO_STORE_URL` | the demo store's URL | the home page's "Open the demo store" button and the 308s from old store paths |
| `GIFTFIT_TRUSTED_PROXY_HOPS` | `1` | Cloud Run adds one proxy hop; rate limits read the client IP from the right `X-Forwarded-For` entry |
| `INGEST_FIXTURE` | `1` | live catalog ingest is off; previews use their own guarded fetcher |
| `NEXT_TELEMETRY_DISABLED` | `1` | |
| `GIT_SHA` | the commit | shown in `/api/health` `version` |
| `EMAIL_PROVIDER`, `SMTP_*`, `EMAIL_FROM*` | optional | email stays off unless `EMAIL_SEND_ENABLED=1` |

Voice needs no variable: with the APIs enabled and the `speech.client` role, live Speech-to-Text and Text-to-Speech are used, with daily caps (`VOICE_STT_DAILY_SECONDS`, `VOICE_TTS_DAILY_CHARS`). `VOICE_ENABLED=0` is the kill switch.

## 5. Deploy: candidate first, then shift traffic

Every release goes out as a **no-traffic candidate**, is checked, and only then gets traffic. Rollback is a traffic shift back to the previous revision.

```bash
APP_URL=https://${SERVICE}-<project-number>.${REGION}.run.app      # the service's stable URL
DEMO_URL=https://giftfit-demo-store-<project-number>.${REGION}.run.app

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUN_SA" \
  --allow-unauthenticated \
  --port 8080 --cpu 1 --memory 1Gi \
  --min-instances 0 --max-instances 1 \
  --concurrency 40 --timeout 360 --cpu-boost \
  --no-traffic --tag candidate \
  --set-env-vars "^@^NODE_ENV=production@YOUCAM_MOCK=0@YOUCAM_ALLOW_PAID=0@YOUCAM_MAX_UNITS_PER_RUN=40@YOUCAM_DAILY_UNIT_CAP=150@STORE=firestore@FIRESTORE_DATABASE_ID=${DB_ID}@GCS_PHOTO_BUCKET=${PHOTO_BUCKET}@GOOGLE_CLOUD_PROJECT=${PROJECT_ID}@APP_BASE_URL=${APP_URL}@GIFTFIT_WIDGET_ORIGINS=${DEMO_URL}@GIFTFIT_DEMO_STORE_URL=${DEMO_URL}@GIFTFIT_TRUSTED_PROXY_HOPS=1@INGEST_FIXTURE=1@NEXT_TELEMETRY_DISABLED=1@GIT_SHA=$(git rev-parse --short HEAD)" \
  --set-secrets "YOUCAM_API_KEY=giftfit-youcam-api-key:latest,ANTHROPIC_API_KEY=giftfit-anthropic-api-key:latest,GIFTFIT_URL_SIGNING_SECRET=giftfit-url-signing-secret:latest,FIT_DECOY_SECRET=giftfit-fit-decoy-secret:latest,CRON_SECRET=giftfit-cron-secret:latest"

# Check the candidate on its tag URL (see step 8), then send it all traffic:
gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-revisions <giftfit-000NN-xxx>=100
# Roll back the same way, to the previous revision name.
```

The first deploy of a new service cannot use `--no-traffic`; drop `--no-traffic --tag candidate` that one time.

Why these flags:
- **`--max-instances 1`**: the cost guard's in-flight units and a few caches are per process. Firestore holds all durable state, so a cold start loses nothing.
- **`--min-instances 0`**: scales to zero when idle, so the services cost almost nothing between visits. The first visit after a quiet spell waits for a cold start.
- **`--timeout 360`**: a real capture polls YouCam for up to 60 × 5 s.
- **`--allow-unauthenticated`**: public access for the store, the widget and the recipient page.

## 6. The demo store

```bash
gcloud run deploy giftfit-demo-store \
  --source server/demo-store \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 --cpu 1 --memory 256Mi \
  --min-instances 0 --max-instances 1 \
  --set-env-vars "GIFTFIT_ORIGIN=${APP_URL}"
```

`GIFTFIT_ORIGIN` is the app the store's script tag loads `giftfit.js` from: point it at the app's stable URL, not at a tag URL. The pages under `server/demo-store/public/` are generated by `node server/demo-store/generate.mjs` and committed.

## 7. Purge cron (Cloud Scheduler)

Expired Fit Requests and overdue photos are deleted by `GET /api/recipient/purge-expired`, which needs `Authorization: Bearer $CRON_SECRET`. It runs hourly, because the photo TTL is at most 1 hour.

```bash
gcloud scheduler jobs create http giftfit-purge-expired \
  --location "$REGION" --schedule "0 * * * *" --time-zone "Etc/UTC" \
  --uri "$APP_URL/api/recipient/purge-expired" --http-method GET \
  --headers "Authorization=Bearer $(gcloud secrets versions access latest --secret=giftfit-cron-secret | tr -d '\r\n')" \
  --attempt-deadline 120s
gcloud scheduler jobs run giftfit-purge-expired --location "$REGION"   # one run now; check the logs
```

The header value is stored in the job's configuration, where project viewers can see it: keep the project's IAM limited to the team. After rotating `giftfit-cron-secret`, update the job with `--update-headers`.

## 8. Smoke check

```bash
URL=https://candidate---<service-hash>.a.run.app     # the candidate's tag URL, or $APP_URL after the shift

curl -s "$URL/api/health"
# {"ok":true,"mock":false,"demoAvailable":true,"paidCallsEnabled":false,"youcamPaid":false,
#  "recording":"off","publicTryOn":"off","version":"0.1.0+giftfit-000NN-xxx"}
# youcamPaid must be false on the public service. The response never contains a key.

curl -s -X POST "$URL/api/demo/seed" -H 'content-type: application/json' -d '{}'
# 201 with recipientPath (/r/...) and giverReportPath (/g/...): the judge demo, 0 YouCam units.

curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/recipient/capture"   # 401 without a recipient session
curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/recipient/purge-expired"     # 401 without the cron secret
```

Also compare the candidate's environment with the live revision (names, and values that are not secret) before shifting:
`gcloud run revisions describe <revision> --region "$REGION" --format='yaml(spec.containers[0].env)'`.

Logs: `gcloud run services logs read "$SERVICE" --region "$REGION" --limit 100`.

## 9. Owner-only recording session (real YouCam try-on)

The public service never makes paid YouCam calls. To record a real try-on (for example the demo video), deploy a **separate no-traffic revision** with the switch on, use it, and remove it:

1. Create the token secret (`giftfit-recording-token`, step 3) and grant the service account access.
2. Deploy a no-traffic revision tagged `recording` with `YOUCAM_RECORDING=on`, `YOUCAM_ALLOW_PAID=1`, `YOUCAM_TOTAL_UNIT_CAP=<cap>`, `YOUCAM_DAILY_UNIT_CAP=<cap>` and `GIFTFIT_RECORDING_TOKEN=giftfit-recording-token:latest` in `--update-secrets`. Check that `/api/health` on its tag URL shows `youcamPaid:true`, and that public paths still offer no try-on.
3. Gift links are built from `APP_BASE_URL`, so the recording needs the revision to serve the stable URL: shift 100% to it, open `/owner/recording#t=<token>` in the recording browser, and record.
4. Shift traffic straight back to the public revision, remove the tag (`gcloud run services update-traffic "$SERVICE" --remove-tags recording`), and check `/api/health` → `youcamPaid:false`.

A failed YouCam task is refunded. The caps fail closed, so a session can never spend more than the cap.

## 10. Teardown

```bash
gcloud scheduler jobs delete giftfit-purge-expired --location "$REGION" --quiet
gcloud run services delete "$SERVICE" --region "$REGION" --quiet
gcloud run services delete giftfit-demo-store --region "$REGION" --quiet
for s in giftfit-youcam-api-key giftfit-anthropic-api-key giftfit-url-signing-secret giftfit-fit-decoy-secret \
         giftfit-cron-secret giftfit-smtp-pass giftfit-recording-token; do
  gcloud secrets delete "$s" --quiet
done
gcloud storage rm -r "gs://${PHOTO_BUCKET}"
gcloud firestore databases delete --database="$DB_ID" --quiet
gcloud iam service-accounts delete "$RUN_SA" --quiet
# In a project shared with other services, delete only GiftFit's images and uploaded sources,
# never the shared cloud-run-source-deploy repository or the whole source bucket.
```

Afterwards, revoke the deployment's API keys at YouCam and Anthropic, or rotate them if they are shared.
