# GiftFit demo store (owner: A6): a plain static shop for the separate Cloud Run service
# `giftfit-demo-store` (min instances 0). Build from the repository root:
#   gcloud builds submit demo-store --tag <region>-docker.pkg.dev/<project>/<repo>/giftfit-demo-store
# Runtime env: GIFTFIT_ORIGIN=https://<giftfit service URL>   (Cloud Run sets PORT)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY server.mjs ./
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
