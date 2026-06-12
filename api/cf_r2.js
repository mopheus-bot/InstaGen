// =====================================================================
// InstaGen — Cloudflare R2 client (S3-compatible)
// =====================================================================
// Hands the generated media bytes (carousel images, completed videos)
// to Cloudflare R2 via the S3-compatible API. We PUT them — never
// buffer — so a 70 MB daily batch never sits in Railway's 512 MB
// RAM at any one moment.
//
// R2 needs AWS SigV4-signed PUTs for writes, even if the bucket is
// public for reads. We hand-roll the signer here (no aws-sdk
// dependency — keeps cold-start fast and the bundle small). The
// signer is PUT-only and supports streaming-style bodies via
// `Uint8Array`.
//
// Env (all optional — the client no-ops when missing):
//   CF_R2_ACCESS_KEY_ID      R2 access key
//   CF_R2_SECRET_ACCESS_KEY  R2 secret
//   CF_R2_ACCOUNT_ID         R2 account id (used in the endpoint URL)
//   CF_R2_BUCKET             bucket name
//   CF_R2_PUBLIC_HOST        e.g. "media.instagen.app" — the custom
//                            domain the user has mapped to the
//                            bucket for public reads. The frontend
//                            uses <img src="https://<HOST>/<key>">
//                            directly, so this MUST be set for
//                            anything beyond dev.
//
// References:
//   - https://developers.cloudflare.com/r2/api/s3/api/
//   - https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// =====================================================================

import crypto from 'node:crypto';

const R2_ACCOUNT_ID = process.env.CF_R2_ACCOUNT_ID || null;
const R2_BUCKET     = process.env.CF_R2_BUCKET     || null;
const R2_ACCESS_KEY = process.env.CF_R2_ACCESS_KEY_ID     || null;
const R2_SECRET_KEY = process.env.CF_R2_SECRET_ACCESS_KEY || null;
const R2_PUBLIC_HOST = process.env.CF_R2_PUBLIC_HOST || null;

export function r2Configured() {
  return Boolean(R2_ACCOUNT_ID && R2_BUCKET && R2_ACCESS_KEY && R2_SECRET_KEY);
}

/**
 * Build the public URL the frontend will use to fetch the bytes.
 * The bucket must have a public custom domain (or the public
 * development URL) mapped to it; this is a function of the
 * deployer's R2 settings, not a configurable knob in this module.
 */
export function r2PublicUrl(key) {
  if (!R2_PUBLIC_HOST) return null;
  // Strip any leading slash from `key`; R2 keys are slash-delimited
  // and we want a clean `https://host/<key>` form.
  return `https://${R2_PUBLIC_HOST}/${key.replace(/^\/+/, '')}`;
}

// ---------------------------------------------------------------------
// AWS SigV4 signer (PUT only)
// ---------------------------------------------------------------------
// The signing process for S3 PUT:
//
//   1. Build the canonical request:
//        METHOD\n<canonical-uri>\n<canonical-query>\n
//        <canonical-headers>\n<signed-headers>\n<hash-of-payload>
//
//   2. Build the string-to-sign:
//        "AWS4-HMAC-SHA256\n<iso8601-timestamp>\n
//         <yyyyMMdd>/<region>/<service>/aws4_request\n
//         <hex(sha256(canonical-request))>"
//
//   3. Compute the signing key:
//        kDate    = HMAC("AWS4"+secret, yyyyMMdd)
//        kRegion  = HMAC(kDate, region)
//        kService = HMAC(kRegion, service)
//        kSigning = HMAC(kService, "aws4_request")
//
//   4. Signature = hex(HMAC(kSigning, string-to-sign))
//
// R2 region is "auto" per Cloudflare docs.

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function amzDate(d = new Date()) {
  // "YYYYMMDDTHHMMSSZ" — UTC.
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}
function dateStamp(amz) {
  return amz.slice(0, 8);
}

function sigV4Headers({ method, url, headers, body, region, service, accessKey, secretKey }) {
  const now     = new Date();
  const amzDateStr = amzDate(now);
  const date     = dateStamp(amzDateStr);

  // Lower-case all header names + trim + collapse spaces. S3 requires
  // header values to be unfolded (CRLF → space).
  const allHeaders = {
    host:                 new URL(url).host,
    'x-amz-content-sha256': sha256Hex(body),
    'x-amz-date':         amzDateStr,
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    ),
  };
  // Header keys must be sorted lexicographically for the canonical
  // request. The `host` and `x-amz-*` defaults above are
  // lower-cased already.
  const sortedKeys = Object.keys(allHeaders).sort();
  const canonicalHeaders =
    sortedKeys.map((k) => `${k}:${allHeaders[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalUri = decodeURIComponent(new URL(url).pathname) || '/';
  const canonicalQuery = '';
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    allHeaders['x-amz-content-sha256'],
  ].join('\n');

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDateStr,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate    = hmac('AWS4' + secretKey, date);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    'x-amz-date': amzDateStr,
    'x-amz-content-sha256': allHeaders['x-amz-content-sha256'],
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * PUT an object to the R2 bucket. `body` must be a `Uint8Array` /
 * `Buffer` (we hash + send as-is). Returns the public URL of the
 * stored object, or `null` if R2 is unconfigured.
 *
 * Throws on non-2xx so the caller can fall back (e.g., to a
 * data: URL for images). We never buffer the body — the SigV4
 * hash is computed from the bytes once, and the same bytes are
 * handed to fetch.
 */
export async function r2PutObject({ key, body, contentType }) {
  if (!r2Configured()) return null;

  const bytes = body instanceof Uint8Array ? body : Buffer.from(body);
  const url = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key.replace(/^\/+/, '')}`;

  const sigHeaders = sigV4Headers({
    method: 'PUT',
    url,
    headers: { 'content-type': contentType || 'application/octet-stream' },
    body: bytes,
    region: 'auto',
    service: 's3',
    accessKey: R2_ACCESS_KEY,
    secretKey: R2_SECRET_KEY,
  });

  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType || 'application/octet-stream', ...sigHeaders },
    body: bytes,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`R2 PUT ${key} failed: ${res.status} ${errBody.slice(0, 200)}`);
  }
  return r2PublicUrl(key);
}
