# Deploying GiftFit to Google Cloud Run

Owner: A8. Target: one public Cloud Run service for the judges, live until **2026-11-20**, then torn down.
Background and the cost comparison are in `docs/reports/A8.md` under "Cloud Run readiness".

**Recommended setup:** build with the repo's `Dockerfile` on Cloud Build (`gcloud run deploy --source .`). Keep state in memory. Run exactly one instance (`--min-instances=1 --max-instances=1`) on request-based billing with 1 vCPU and 1 GiB. Every secret comes from Secret Manager.

Nothing on this page has been run against a real project yet. Placeholders look like `<THIS>`. Never paste a secret value into a file, a commit, a chat or a shell history you share.

The commands use bash (Git Bash works on Windows). Run them from the repo root.

## 0. Before every deploy

```bash
npm run gate:full          # lint, typecheck, unit, build, e2e (mock mode). Must be green.
git status                 # deploy a committed state; .gcloudignore keeps .env*, real face recordings,
                           # agent folders, docs and tests out of the upload
```

The image never contains Playwright, Chromium, the dev dependencies, `fixtures/youcam/real/` or `data/aurum/photo-inbox/` (see `Dockerfile`, `.dockerignore`, `.gcloudignore`). Tier 3 live ingest is off in the deployment: `INGEST_FIXTURE=1` serves the committed ingest snapshots, and `POST /api/ingest` refuses any other host with `403 "INGEST_FIXTURE=1 only serves fixture hosts"`.

## 1. Project, APIs, service account

```bash
export PROJECT_ID=<your-project-id>
export REGION=us-central1
export SERVICE=giftfit
export RUN_SA=giftfit-run@${PROJECT_ID}.iam.gserviceaccount.com

gcloud auth login
gcloud config set project "$PROJECT_ID"
gcloud config set run/region "$REGION"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com

# Runtime identity with no roles except reading its own secrets (step 2).
gcloud iam service-accounts create giftfit-run --display-name="GiftFit Cloud Run runtime"
```

Optional, but recommended: a budget alert on the billing account.

```bash
gcloud billing budgets create --billing-account=<BILLING_ACCOUNT_ID> --display-name="giftfit judging" \
  --budget-amount=30USD --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

## 2. Secrets (Secret Manager)

There are five secrets. The first two are values you already hold; the last three are random values generated here and never printed.

| Env var in the app | Secret name | Value |
|---|---|---|
| `YOUCAM_API_KEY` | `youcam-api-key` | the YouCam key (R0) |
| `ANTHROPIC_API_KEY` | `anthropic-api-key` | the Anthropic key (R0) |
| `GIFTFIT_URL_SIGNING_SECRET` | `giftfit-url-signing-secret` | random, 32 bytes |
| `FIT_DECOY_SECRET` | `fit-decoy-secret` | random, 32 bytes |
| `CRON_SECRET` | `cron-secret` | random, 24 bytes |

```bash
# Keys you hold: read without echo, pipe straight in, then clear the variable.
read -rs YOUCAM_KEY && printf '%s' "$YOUCAM_KEY" | gcloud secrets create youcam-api-key --replication-policy=automatic --data-file=- && unset YOUCAM_KEY
read -rs ANTHROPIC_KEY && printf '%s' "$ANTHROPIC_KEY" | gcloud secrets create anthropic-api-key --replication-policy=automatic --data-file=- && unset ANTHROPIC_KEY

# Random secrets, generated and stored without being shown.
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create giftfit-url-signing-secret --replication-policy=automatic --data-file=-
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create fit-decoy-secret --replication-policy=automatic --data-file=-
openssl rand -hex 24 | tr -d '\n' | gcloud secrets create cron-secret --replication-policy=automatic --data-file=-

for s in youcam-api-key anthropic-api-key giftfit-url-signing-secret fit-decoy-secret cron-secret; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${RUN_SA}" --role=roles/secretmanager.secretAccessor
done
```

To rotate one: `... | gcloud secrets versions add <name> --data-file=-`. Redeploy, or run `gcloud run services update "$SERVICE"`, so the new `latest` is picked up. Then destroy the old version, because only 6 active versions are free.

## 3. Build and deploy

`--source .` uploads the repo (minus `.gcloudignore`), builds the `Dockerfile` on Cloud Build and pushes the image to Artifact Registry (`$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy`). Then it deploys.

```bash
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUN_SA" \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 --memory 1Gi \
  --min-instances 1 --max-instances 1 \
  --concurrency 40 \
  --timeout 360 \
  --cpu-boost \
  --set-env-vars "^@^NODE_ENV=production@YOUCAM_MOCK=0@YOUCAM_ALLOW_PAID=1@YOUCAM_RESERVE_UNITS=300@YOUCAM_MAX_UNITS_PER_RUN=40@INGEST_FIXTURE=1@GIFTFIT_DATA_DIR=/tmp/giftfit@NEXT_TELEMETRY_DISABLED=1" \
  --set-secrets "YOUCAM_API_KEY=youcam-api-key:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest,GIFTFIT_URL_SIGNING_SECRET=giftfit-url-signing-secret:latest,FIT_DECOY_SECRET=fit-decoy-secret:latest,CRON_SECRET=cron-secret:latest"
```

Why these flags:
- **`--max-instances 1` is required, not a cost choice.** Fit Requests, try-on photos, the cost guard's in-flight units, the demo rate limit and the job registry all live in process memory, so a second instance would split them.
- **`--min-instances 1`** keeps that single instance and its memory alive between judge visits.
- **Request-based billing** is the default; don't pass `--no-cpu-throttling`. An idle minimum instance is billed at the idle rate. Async ingest jobs only progress while requests come in, which is fine because the UI polls.
- **`--timeout 360`**: a real capture polls YouCam for up to 60 × 5 s.
- **`--allow-unauthenticated`** gives the judges public access. Requests denied by IAM would not be billed, but here every request is allowed.
- **A mock-only deployment** (0 units even for judges' selfies): set `YOUCAM_MOCK=1@YOUCAM_ALLOW_PAID=0` and drop `youcam-api-key` from `--set-secrets`.

Later deploys run the same command. To change only env or secrets, use `gcloud run services update "$SERVICE" --update-env-vars ... / --update-secrets ...`.

`GIFTFIT_EMBED_ANCESTORS` (the retailer sites allowed to frame `/embed`) and the `INGEST_*` variables are optional. See `.env.example`.

## 4. Purge cron (Cloud Scheduler)

Expired Fit Requests and overdue photos are deleted by `GET /api/recipient/purge-expired`, which needs `Authorization: Bearer $CRON_SECRET`. Run it hourly, because the photo TTL is at most 1 h.

```bash
URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
gcloud scheduler jobs create http giftfit-purge-expired \
  --location "$REGION" --schedule "0 * * * *" --time-zone "Etc/UTC" \
  --uri "$URL/api/recipient/purge-expired" --http-method GET \
  --headers "Authorization=Bearer $(gcloud secrets versions access latest --secret=cron-secret)" \
  --attempt-deadline 120s
gcloud scheduler jobs run giftfit-purge-expired --location "$REGION"   # one run now; check the logs
```

The header value is stored in the job's configuration, where project viewers can see it. Keep the project's IAM limited to the team. If you rotate `cron-secret`, run `gcloud scheduler jobs update http ... --update-headers` with the new value.

## 5. Smoke check

```bash
URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')

curl -s "$URL/api/health"
# expect {"ok":true,"mock":false,"demoAvailable":true,"paidCallsEnabled":true,"version":"0.1.0+giftfit-000NN-xxx"}
# (mock:true / paidCallsEnabled:false for a mock-only deployment). Never contains a key.

curl -s -X POST "$URL/api/demo/seed" -H 'content-type: application/json' -d '{}'
# expect 201 with recipientPath (/r/...) and giverReportPath (/g/...). 0 YouCam units.
# Open "$URL<recipientPath>" on a phone: the carousel of the AI-generated model loads without a selfie.

# The recipient-only routes refuse anonymous callers:
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/recipient/capture"     # 401
curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/recipient/purge-expired"       # 401
# Live ingest is disabled:
curl -s -X POST "$URL/api/ingest" -H 'content-type: application/json' -d '{"url":"https://example.com"}'   # 403

# Rate-limit spoofing check: the demo allows 10 seeds per IP per hour. With a forged
# X-Forwarded-For on every call, the 11th call must still return 429. If it returns 201,
# the client-IP helper trusts the forged header (see A8.md, judge cost safety).
for i in $(seq 1 11); do curl -s -o /dev/null -w '%{http_code} ' -X POST "$URL/api/demo/seed" \
  -H "X-Forwarded-For: 203.0.113.$i" -H 'content-type: application/json' -d '{}'; done; echo
```

Logs: `gcloud run services logs read "$SERVICE" --region "$REGION" --limit 100`.

## 6. Custom domain (optional)

```bash
gcloud beta run domain-mappings create --service "$SERVICE" --domain <gift.example.com> --region "$REGION"
gcloud beta run domain-mappings describe --domain <gift.example.com> --region "$REGION"   # DNS records to add
```

Domain mappings are a preview feature and not offered in every region (us-central1 has them). The alternative is a global external Application Load Balancer with a serverless NEG, which costs extra. If you put a load balancer in front, the client-IP rule changes (A8.md).

## 7. Teardown after 2026-11-20

```bash
gcloud scheduler jobs delete giftfit-purge-expired --location "$REGION" --quiet
gcloud run services delete "$SERVICE" --region "$REGION" --quiet
for s in youcam-api-key anthropic-api-key giftfit-url-signing-secret fit-decoy-secret cron-secret; do
  gcloud secrets delete "$s" --quiet
done
gcloud artifacts repositories delete cloud-run-source-deploy --location "$REGION" --quiet
gcloud iam service-accounts delete "$RUN_SA" --quiet
# Cloud Build keeps the uploaded source in gs://${PROJECT_ID}_cloudbuild; remove it too:
gcloud storage rm -r "gs://${PROJECT_ID}_cloudbuild" 
# If the project exists only for this: gcloud projects delete "$PROJECT_ID"
```

Afterwards, revoke the deployment's API keys at YouCam and Anthropic, or rotate them if they are shared.
