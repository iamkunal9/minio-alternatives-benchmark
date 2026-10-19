# MinIO alternatives benchmark: RustFS vs SeaweedFS vs MinIO

A small, reproducible, single-node benchmark of S3-compatible object stores that people are
moving to now that the MinIO community edition is no longer maintained:

- **RustFS** `1.0.3`
- **SeaweedFS** `4.48` (`weed mini`)
- **MinIO** `RELEASE.2025-10-15T17-29-55Z` (last community release, built from source as the baseline)

It measures **throughput, tail latency, memory, CPU, startup, disk usage, S3 API compatibility,
and crash durability** with default settings.

Write-up with charts and discussion:
**https://iamkunal9.in/blog/minio-alternatives-rustfs-vs-seaweedfs-benchmark**

Full numbers: [`results/RESULTS.md`](results/RESULTS.md) · machine-readable: [`results/summary.json`](results/summary.json) · test environment: [`results/environment.json`](results/environment.json)

## Headline (v1, 2026-10-19, Apple M2 / Docker VM 8 vCPU / 3.8 GiB, defaults, single node)

- **RustFS 1.0.3 is the closest drop-in for MinIO**: throughput on par with MinIO (clearly ahead only on 64 KiB reads, 150 vs 122 MiB/s; other gaps are within run-to-run noise) at similar memory: **348 MiB** peak vs MinIO's 394 MiB.
- **SeaweedFS 4.48 (`weed mini`) wins small uploads** (99 vs RustFS 57 MiB/s on 64 KiB PUT) but is 2–3× slower on large writes (8 MiB PUT 107 vs 326 MiB/s; 256 MiB multipart 126 vs 276 MiB/s) and peaks at **1480 MiB** of memory.
- CPU for the same workload is the same for all three (~2.2 cores); no disk overhead (~613 MiB for 607 MiB).
- **Zero lost or corrupt acknowledged objects** across 6 `kill -9` cycles per store (26,111 writes).
- 14/15 S3 checks pass on each: RustFS and SeaweedFS drop `x-amz-meta-*` signed into presigned PUT URLs; MinIO returns `NotImplemented` for `PutBucketCors`.


## What is measured

| Area | How |
|---|---|
| Throughput & latency | 607 MiB of random (incompressible) data: 500 × 64 KiB (16 concurrent), 40 × 8 MiB (4 concurrent), one 256 MiB multipart upload in 16 MiB parts (4 concurrent). Each object is written, then read back. MiB/s, ops/s, p50/p99. |
| Memory | Container cgroup v2 `anon` (heap; page cache excluded): idle after 15 s, and peak sampled every 0.5 s during the measured pass. |
| CPU | Container cgroup `cpu.stat` `usage_usec` delta over the measured pass, divided by wall time (= average cores). |
| Startup | Container start → first HTTP response. |
| Disk | `du` of the data directory after the dataset is written once. |
| S3 compatibility | 15 checks with the AWS SDK for JavaScript v3: CORS config, browser presigned PUT + preflight, metadata in presigned URLs, metadata on PutObject, presigned GET, CopyObject, Range GET, If-None-Match 304, ListObjectsV2 pagination, multipart + UploadPartCopy, abort multipart, tagging, versioning, batch delete. |
| Crash durability | 8 writers upload 256–280 KiB objects for 4 s; the store is `kill -9`'d mid-write or right after the last ack, restarted on the same volume, and every **acknowledged** object is read back and SHA-256 verified. 6 cycles per store. |

### Fairness

- Single node, single drive, **defaults only** (no tuning) for every store.
- Every run: fresh container + fresh volume, one discarded warm-up pass, then the measured pass.
- 5 iterations; stores are **interleaved and rotated** each iteration (R S M, S M R, M R S, …) with a cooldown, so thermal throttling or background noise is not one store's bias. Results are median with min–max.
- The client runs **in a container on the same Docker network** as the store (no host port-forwarding in the data path). Client and store share the same CPUs.

## Limitations

- One machine (see `results/environment.json`). Absolute numbers will differ on Linux servers with NVMe; the relative picture is what this measures.
- `kill -9` kills the process, not the machine — the page cache survives. This shows crash recovery, **not** power-loss durability / fsync policy.
- Single node only: erasure coding, replication, healing and multi-node failures are not exercised.

## Run it yourself

Requirements: Docker (with ~4 GB RAM for the VM) and Node 20+.

```bash
git clone https://github.com/iamkunal9/minio-alternatives-benchmark.git
cd minio-alternatives-benchmark
npm ci
./run.sh                 # ~35 min: 5 interleaved runs per store + crash cycles
node bench/report.mjs    # regenerates results/RESULTS.md and results/summary.json
```

Knobs: `ITERATIONS=5`, `STORES="rustfs seaweedfs minio"`, `DUR_CYCLES=6`, `COOLDOWN=20`, `SETTLE=15`.
To test other versions, change the image tags / `MINIO_TAG` at the top of `run.sh`.

## Layout

```
run.sh                  orchestrator (stores, interleaving, cgroup sampling, durability, environment capture)
bench/bench.mjs         S3 client: compat | perf | dur-write | dur-verify | wait
bench/report.mjs        aggregates results/raw → results/summary.json + results/RESULTS.md
stores/minio/Dockerfile builds MinIO from the last community release tag
results/                committed results of the published run
```

## License

MIT
