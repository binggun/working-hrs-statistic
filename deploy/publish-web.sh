#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WEB_BUCKET:?Set WEB_BUCKET to the dedicated website bucket}"
: "${VITE_API_URL:?Set VITE_API_URL to the HTTPS API origin}"
npm ci
npm run build
# Does not delete remote objects. Immutable hashed assets uploaded before index.
aws s3 sync web/dist/assets/ "s3://$WEB_BUCKET/assets/" --cache-control 'public,max-age=31536000,immutable'
aws s3 cp web/dist/index.html "s3://$WEB_BUCKET/index.html" --cache-control 'no-cache' --content-type 'text/html'
if [[ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ]]; then
  aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths '/index.html' '/'
fi
