// S3 benchmark client: compatibility checks, throughput, crash-durability write/verify.
// Runs inside the client container on the same Docker network as the store (see run.sh).
//
//   node bench/bench.mjs <endpoint> compat
//   node bench/bench.mjs <endpoint> perf
//   node bench/bench.mjs <endpoint> dur-write <stateFile>
//   node bench/bench.mjs <endpoint> dur-verify <stateFile>
//   node bench/bench.mjs <endpoint> wait          (prints ms until the endpoint answers HTTP)
import * as S3 from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [endpoint, phase, stateFile] = process.argv.slice(2);
const Bucket = process.env.BENCH_BUCKET ?? 'bench';
const clientOptions = {
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'benchkey', secretAccessKey: 'benchsecret123' },
  // Plain SigV4 + Content-MD5-free requests, the widest common denominator across stores.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
};
const s3 = new S3.S3Client(clientOptions);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const now = () => performance.now();
const bytes = async (body) => Buffer.from(await body.transformToByteArray());

async function ensureBucket(name = Bucket) {
  try {
    await s3.send(new S3.CreateBucketCommand({ Bucket: name }));
  } catch (e) {
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(e.name)) throw e;
  }
}

/** One check per S3 feature commonly relied on by apps; each reports ok / FAIL <reason>. */
async function compat() {
  const results = {};
  const check = async (name, fn) => {
    try {
      const r = await fn();
      results[name] = r === undefined ? 'ok' : r;
    } catch (e) {
      results[name] = `FAIL ${e.name ?? 'Error'}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 140)}`;
    }
  };
  const body = randomBytes(64 * 1024);
  const digest = sha(body);
  const origin = 'http://localhost:3000';

  await check('CreateBucket', () => ensureBucket());
  await check('PutBucketCors / GetBucketCors', async () => {
    await s3.send(new S3.PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [{
      AllowedOrigins: ['*'], AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3000,
    }] } }));
    const c = await s3.send(new S3.GetBucketCorsCommand({ Bucket }));
    if (!c.CORSRules?.length) throw new Error('no rules returned');
  });
  await check('Presigned PUT from a browser (CORS preflight + PUT)', async () => {
    const url = await getSignedUrl(s3, new S3.PutObjectCommand({ Bucket, Key: 'compat/browser.zip', ContentType: 'application/zip' }), { expiresIn: 300 });
    const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    const allow = pre.headers.get('access-control-allow-origin');
    const put = await fetch(url, { method: 'PUT', body, headers: { Origin: origin, 'Content-Type': 'application/zip' } });
    if (!put.ok) throw new Error(`PUT ${put.status}`);
    if (!allow) throw new Error(`preflight ${pre.status} without Access-Control-Allow-Origin`);
  });
  await check('Presigned PUT keeps x-amz-meta-* signed into the URL', async () => {
    const url = await getSignedUrl(s3, new S3.PutObjectCommand({ Bucket, Key: 'compat/meta-url.bin', Metadata: { origin: 'presigned' } }), { expiresIn: 300 });
    const put = await fetch(url, { method: 'PUT', body });
    if (!put.ok) throw new Error(`PUT ${put.status}`);
    const h = await s3.send(new S3.HeadObjectCommand({ Bucket, Key: 'compat/meta-url.bin' }));
    if (h.Metadata?.origin !== 'presigned') throw new Error(`metadata not stored (got ${JSON.stringify(h.Metadata)})`);
  });
  await check('PutObject metadata -> HeadObject', async () => {
    await s3.send(new S3.PutObjectCommand({ Bucket, Key: 'compat/obj.bin', Body: body, Metadata: { sha256: digest } }));
    const h = await s3.send(new S3.HeadObjectCommand({ Bucket, Key: 'compat/obj.bin' }));
    if (h.Metadata?.sha256 !== digest) throw new Error(`metadata ${JSON.stringify(h.Metadata)}`);
    if (h.ContentLength !== body.length) throw new Error(`ContentLength ${h.ContentLength}`);
  });
  await check('Presigned GET', async () => {
    const url = await getSignedUrl(s3, new S3.GetObjectCommand({ Bucket, Key: 'compat/obj.bin' }), { expiresIn: 300 });
    const r = await fetch(url);
    if (sha(Buffer.from(await r.arrayBuffer())) !== digest) throw new Error('content mismatch');
  });
  await check('CopyObject (server-side)', async () => {
    await s3.send(new S3.CopyObjectCommand({ Bucket, Key: 'compat/copy.bin', CopySource: `${Bucket}/compat/obj.bin` }));
    const g = await s3.send(new S3.GetObjectCommand({ Bucket, Key: 'compat/copy.bin' }));
    if (sha(await bytes(g.Body)) !== digest) throw new Error('content mismatch');
  });
  await check('Range GET', async () => {
    const g = await s3.send(new S3.GetObjectCommand({ Bucket, Key: 'compat/obj.bin', Range: 'bytes=100-199' }));
    if (!(await bytes(g.Body)).equals(body.subarray(100, 200))) throw new Error('wrong range');
  });
  await check('Conditional GET (If-None-Match -> 304)', async () => {
    const h = await s3.send(new S3.HeadObjectCommand({ Bucket, Key: 'compat/obj.bin' }));
    try {
      await s3.send(new S3.GetObjectCommand({ Bucket, Key: 'compat/obj.bin', IfNoneMatch: h.ETag }));
    } catch (e) {
      if (e.$metadata?.httpStatusCode === 304) return;
      throw e;
    }
    throw new Error('expected 304 Not Modified');
  });
  await check('ListObjectsV2 (prefix + pagination)', async () => {
    const seen = [];
    let ContinuationToken;
    do {
      const l = await s3.send(new S3.ListObjectsV2Command({ Bucket, Prefix: 'compat/', MaxKeys: 2, ContinuationToken }));
      seen.push(...(l.Contents ?? []).map((c) => c.Key));
      ContinuationToken = l.NextContinuationToken;
    } while (ContinuationToken);
    const want = ['compat/browser.zip', 'compat/copy.bin', 'compat/meta-url.bin', 'compat/obj.bin'];
    if (seen.sort().join() !== want.join()) throw new Error(`got ${seen.join()}`);
  });
  await check('Multipart upload + UploadPartCopy', async () => {
    const part = randomBytes(5 * 1024 * 1024);
    const Key = 'compat/mp.bin';
    const { UploadId } = await s3.send(new S3.CreateMultipartUploadCommand({ Bucket, Key }));
    const p1 = await s3.send(new S3.UploadPartCommand({ Bucket, Key, UploadId, PartNumber: 1, Body: part }));
    const p2 = await s3.send(new S3.UploadPartCopyCommand({ Bucket, Key, UploadId, PartNumber: 2, CopySource: `${Bucket}/compat/obj.bin` }));
    await s3.send(new S3.CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [
      { PartNumber: 1, ETag: p1.ETag }, { PartNumber: 2, ETag: p2.CopyPartResult.ETag },
    ] } }));
    const g = await s3.send(new S3.GetObjectCommand({ Bucket, Key }));
    if (sha(await bytes(g.Body)) !== sha(Buffer.concat([part, body]))) throw new Error('content mismatch');
  });
  await check('AbortMultipartUpload', async () => {
    const Key = 'compat/aborted.bin';
    const { UploadId } = await s3.send(new S3.CreateMultipartUploadCommand({ Bucket, Key }));
    await s3.send(new S3.UploadPartCommand({ Bucket, Key, UploadId, PartNumber: 1, Body: randomBytes(5 * 1024 * 1024) }));
    await s3.send(new S3.AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
    const l = await s3.send(new S3.ListMultipartUploadsCommand({ Bucket }));
    if ((l.Uploads ?? []).some((u) => u.UploadId === UploadId)) throw new Error('upload still listed');
  });
  await check('Object tagging', async () => {
    await s3.send(new S3.PutObjectTaggingCommand({ Bucket, Key: 'compat/obj.bin', Tagging: { TagSet: [{ Key: 'env', Value: 'bench' }] } }));
    const t = await s3.send(new S3.GetObjectTaggingCommand({ Bucket, Key: 'compat/obj.bin' }));
    if (t.TagSet?.[0]?.Value !== 'bench') throw new Error(JSON.stringify(t.TagSet));
  });
  await check('Bucket versioning', async () => {
    const vb = `${Bucket}-versioned`;
    await ensureBucket(vb);
    await s3.send(new S3.PutBucketVersioningCommand({ Bucket: vb, VersioningConfiguration: { Status: 'Enabled' } }));
    await s3.send(new S3.PutObjectCommand({ Bucket: vb, Key: 'v.txt', Body: 'one' }));
    await s3.send(new S3.PutObjectCommand({ Bucket: vb, Key: 'v.txt', Body: 'two' }));
    const v = await s3.send(new S3.ListObjectVersionsCommand({ Bucket: vb, Prefix: 'v.txt' }));
    if ((v.Versions ?? []).length !== 2) throw new Error(`${(v.Versions ?? []).length} versions`);
  });
  await check('DeleteObjects (batch)', async () => {
    const keys = ['compat/browser.zip', 'compat/meta-url.bin', 'compat/obj.bin', 'compat/copy.bin', 'compat/mp.bin'];
    const r = await s3.send(new S3.DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
    if (r.Errors?.length) throw new Error(JSON.stringify(r.Errors[0]));
    const l = await s3.send(new S3.ListObjectsV2Command({ Bucket, Prefix: 'compat/' }));
    if (l.KeyCount) throw new Error(`${l.KeyCount} keys left`);
  });
  console.log(JSON.stringify(results, null, 2));
}

/** Runs fn(0..n-1) with a fixed concurrency; returns latency percentiles in ms. */
async function pool(n, concurrency, fn) {
  const lat = [];
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < n) {
      const k = i++;
      const t = now();
      await fn(k);
      lat.push(now() - t);
    }
  }));
  lat.sort((a, b) => a - b);
  const p = (q) => +lat[Math.min(lat.length - 1, Math.floor(lat.length * q))].toFixed(1);
  return { p50: p(0.5), p99: p(0.99) };
}

async function objects(name, count, size, concurrency) {
  const bodies = Array.from({ length: Math.min(count, 8) }, () => randomBytes(size));
  const key = (k) => `perf/${name}/${k}`;
  const mib = (count * size) / 1048576;
  let t = now();
  const put = await pool(count, concurrency, (k) => s3.send(new S3.PutObjectCommand({ Bucket, Key: key(k), Body: bodies[k % bodies.length] })));
  const putS = (now() - t) / 1000;
  t = now();
  const get = await pool(count, concurrency, async (k) => {
    const g = await s3.send(new S3.GetObjectCommand({ Bucket, Key: key(k) }));
    await g.Body.transformToByteArray();
  });
  const getS = (now() - t) / 1000;
  return {
    name, count, sizeKiB: size / 1024, concurrency,
    put: { MiBps: +(mib / putS).toFixed(1), ops: +(count / putS).toFixed(1), p50ms: put.p50, p99ms: put.p99 },
    get: { MiBps: +(mib / getS).toFixed(1), ops: +(count / getS).toFixed(1), p50ms: get.p50, p99ms: get.p99 },
  };
}

async function multipart(totalMiB, partMiB, concurrency) {
  const part = randomBytes(partMiB * 1048576);
  const Key = 'perf/multipart/large.bin';
  let t = now();
  const { UploadId } = await s3.send(new S3.CreateMultipartUploadCommand({ Bucket, Key }));
  const parts = [];
  await pool(totalMiB / partMiB, concurrency, async (k) => {
    const r = await s3.send(new S3.UploadPartCommand({ Bucket, Key, UploadId, PartNumber: k + 1, Body: part }));
    parts[k] = { PartNumber: k + 1, ETag: r.ETag };
  });
  await s3.send(new S3.CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: parts } }));
  const putS = (now() - t) / 1000;
  t = now();
  const g = await s3.send(new S3.GetObjectCommand({ Bucket, Key }));
  let n = 0;
  for await (const c of g.Body) n += c.length;
  const getS = (now() - t) / 1000;
  if (n !== totalMiB * 1048576) throw new Error(`short read ${n}`);
  return { name: `multipart-${totalMiB}MiB`, partMiB, concurrency, put: { MiBps: +(totalMiB / putS).toFixed(1) }, get: { MiBps: +(totalMiB / getS).toFixed(1) } };
}

/** Workload: 607 MiB of random (incompressible) data across three object-size classes. */
async function perf() {
  await ensureBucket();
  const t = now();
  const scenarios = [
    await objects('small-64KiB', 500, 64 * 1024, 16),
    await objects('medium-8MiB', 40, 8 * 1048576, 4),
    await multipart(256, 16, 4),
  ];
  console.log(JSON.stringify({ wallSeconds: +((now() - t) / 1000).toFixed(2), scenarios }));
}

/** Writes 256-280 KiB objects with 8 writers for 4 s, recording only acknowledged writes. */
async function durWrite() {
  await ensureBucket();
  const durClient = new S3.S3Client({ ...clientOptions, maxAttempts: 1 });
  const acked = [];
  const deadline = Date.now() + 4000;
  let k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (Date.now() < deadline) {
      const n = k++;
      const body = randomBytes(256 * 1024 + (n % 7) * 4096);
      const Key = `dur/${process.pid}/${n}`;
      try {
        // No retries + 10 s cap: after kill -9 an in-flight request would otherwise hang until TCP timeout.
        await durClient.send(new S3.PutObjectCommand({ Bucket, Key, Body: body }), { abortSignal: AbortSignal.timeout(10_000) });
      } catch {
        return; // store was killed; this write was never acknowledged
      }
      acked.push({ Key, sha: sha(body), len: body.length });
      writeFileSync(stateFile, JSON.stringify(acked));
    }
  }));
  writeFileSync(stateFile, JSON.stringify(acked));
}

async function durVerify() {
  const acked = JSON.parse(readFileSync(stateFile, 'utf8'));
  let ok = 0, missing = 0, corrupt = 0;
  for (const { Key, sha: want, len } of acked) {
    try {
      const b = await bytes((await s3.send(new S3.GetObjectCommand({ Bucket, Key }))).Body);
      if (b.length === len && sha(b) === want) ok++;
      else corrupt++;
    } catch {
      missing++;
    }
  }
  console.log(JSON.stringify({ acked: acked.length, ok, missing, corrupt }));
}

async function wait() {
  const t = now();
  for (;;) {
    try {
      await fetch(endpoint, { signal: AbortSignal.timeout(1000) });
      console.log(Math.round(now() - t));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

const phases = { compat, perf, 'dur-write': durWrite, 'dur-verify': durVerify, wait };
if (!phases[phase]) throw new Error(`unknown phase ${phase}`);
await phases[phase]();
