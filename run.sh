#!/usr/bin/env bash
# Single-node S3 store benchmark: RustFS vs SeaweedFS vs MinIO (built from source).
#
#   ./run.sh                      # all stores, 5 interleaved iterations + durability
#   ITERATIONS=1 STORES="rustfs" ./run.sh
#
# Every run uses a fresh container + volume, a discarded warm-up pass, then a measured pass.
# Stores are interleaved (and rotated) per iteration so thermal drift is not one store's bias.
# The client runs in a container on the same Docker network (no host port forwarding).
# Raw results: results/raw/*.json; summary: `node bench/report.mjs`.
set -euo pipefail
cd "$(dirname "$0")"

ITERATIONS=${ITERATIONS:-5}
read -r -a STORES <<< "${STORES:-rustfs seaweedfs minio}"
DUR_CYCLES=${DUR_CYCLES:-6}
COOLDOWN=${COOLDOWN:-20}
SETTLE=${SETTLE:-15}

RUSTFS_IMAGE=rustfs/rustfs:1.0.3
SEAWEEDFS_IMAGE=chrislusf/seaweedfs:4.48
MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
MINIO_IMAGE=minio-src:$MINIO_TAG
CLIENT_IMAGE=node:24-slim
NET=s3bench
RAW=results/raw
mkdir -p "$RAW"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

setup() {
  docker pull -q "$RUSTFS_IMAGE" >/dev/null
  docker pull -q "$SEAWEEDFS_IMAGE" >/dev/null
  docker pull -q "$CLIENT_IMAGE" >/dev/null
  docker image inspect "$MINIO_IMAGE" >/dev/null 2>&1 \
    || docker build -q --build-arg MINIO_TAG="$MINIO_TAG" -t "$MINIO_IMAGE" stores/minio >/dev/null
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  printf '%s' '{"identities":[{"name":"admin","credentials":[{"accessKey":"benchkey","secretKey":"benchsecret123"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' > "$RAW/seaweedfs-s3.json"
  docker rm -f s3-client >/dev/null 2>&1 || true
  docker run -d --name s3-client --network "$NET" -v "$PWD":/bench -w /bench "$CLIENT_IMAGE" sleep infinity >/dev/null
}

endpoint() { case $1 in seaweedfs) echo "http://s3-seaweedfs:8333" ;; *) echo "http://s3-$1:9000" ;; esac; }
client() { docker exec s3-client node bench/bench.mjs "$@"; }

start_store() { # <store> <volume>
  local s=$1 v=$2
  docker rm -f "s3-$s" >/dev/null 2>&1 || true
  case $s in
    rustfs)
      docker run -d --name s3-rustfs --network "$NET" -v "$v":/data \
        -e RUSTFS_ACCESS_KEY=benchkey -e RUSTFS_SECRET_KEY=benchsecret123 "$RUSTFS_IMAGE" >/dev/null ;;
    seaweedfs)
      docker run -d --name s3-seaweedfs --network "$NET" -v "$v":/data -v "$PWD/$RAW/seaweedfs-s3.json":/etc/s3.json:ro \
        "$SEAWEEDFS_IMAGE" mini -dir=/data -s3.config=/etc/s3.json >/dev/null ;;
    minio)
      docker run -d --name s3-minio --network "$NET" -v "$v":/data \
        -e MINIO_ROOT_USER=benchkey -e MINIO_ROOT_PASSWORD=benchsecret123 "$MINIO_IMAGE" server /data >/dev/null ;;
  esac
}

# Container cgroup v2 counters (read from inside the container's own cgroup namespace).
anon_mib() { docker exec "s3-$1" awk '/^anon /{printf "%.1f", $2/1048576}' /sys/fs/cgroup/memory.stat; }
cpu_usec() { docker exec "s3-$1" awk '/^usage_usec /{print $2}' /sys/fs/cgroup/cpu.stat; }

perf_run() { # <store> <iteration>
  local s=$1 i=$2 vol="bench-$1-$2" ep out=$RAW/run-$1-$2.json
  ep=$(endpoint "$s")
  docker volume rm "$vol" >/dev/null 2>&1 || true
  start_store "$s" "$vol"
  local ready_ms; ready_ms=$(client "$ep" wait)
  sleep "$SETTLE"
  local idle; idle=$(anon_mib "$s")
  [[ $i == 1 ]] && client "$ep" compat > "$RAW/compat-$s.json"
  log "$s #$i warm-up"
  client "$ep" perf > /dev/null
  local disk; disk=$(docker exec "s3-$s" du -sm /data | awk '{print $1}')
  sleep 5
  local cpu0; cpu0=$(cpu_usec "$s")
  : > "$RAW/samples-$s-$i.txt"
  ( while :; do anon_mib "$s" >> "$RAW/samples-$s-$i.txt" 2>/dev/null; echo >> "$RAW/samples-$s-$i.txt"; sleep 0.5; done ) & local sampler=$!
  log "$s #$i measured"
  local perf; perf=$(client "$ep" perf)
  kill "$sampler"; wait "$sampler" 2>/dev/null || true
  local cpu1; cpu1=$(cpu_usec "$s")
  local peak; peak=$(sort -n "$RAW/samples-$s-$i.txt" | tail -1)
  node -e '
    const [s, i, ready, idle, disk, peak, cpu0, cpu1, perf] = process.argv.slice(1);
    const p = JSON.parse(perf);
    const cores = (cpu1 - cpu0) / 1e6 / p.wallSeconds;
    console.log(JSON.stringify({ store: s, iteration: +i, readyMs: +ready, idleAnonMiB: +idle, peakAnonMiB: +peak,
      avgCpuCores: +cores.toFixed(2), diskMiBAfterOneCopy: +disk, ...p }));
  ' "$s" "$i" "$ready_ms" "$idle" "$disk" "$peak" "$cpu0" "$cpu1" "$perf" > "$out"
  docker rm -f "s3-$s" >/dev/null; docker volume rm "$vol" >/dev/null
  log "$s #$i done: $(head -c 160 "$out")"
}

# Crash durability: kill -9 the store mid-write (odd cycles) or right after the last ack (even),
# restart it on the same volume, and verify every acknowledged object byte-for-byte.
durability() { # <store>
  local s=$1 vol="bench-$1-dur" ep; ep=$(endpoint "$s")
  docker volume rm "$vol" >/dev/null 2>&1 || true
  start_store "$s" "$vol"; client "$ep" wait >/dev/null
  local out=$RAW/durability-$s.json; echo '[]' > "$out"
  for c in $(seq 1 "$DUR_CYCLES"); do
    local state=$RAW/dur-$s-$c.state; echo '[]' > "$state"
    if (( c % 2 )); then
      client "$ep" dur-write "/bench/$state" & local w=$!
      sleep 2; docker kill -s KILL "s3-$s" >/dev/null; wait "$w" || true; local mode=mid-write
    else
      client "$ep" dur-write "/bench/$state"; docker kill -s KILL "s3-$s" >/dev/null; local mode=after-ack
    fi
    docker start "s3-$s" >/dev/null; client "$ep" wait >/dev/null; sleep 3
    local r; r=$(client "$ep" dur-verify "/bench/$state")
    node -e 'const f=process.argv[1];const a=JSON.parse(require("fs").readFileSync(f,"utf8"));a.push({cycle:+process.argv[2],mode:process.argv[3],...JSON.parse(process.argv[4])});require("fs").writeFileSync(f,JSON.stringify(a,null,2))' "$out" "$c" "$mode" "$r"
    log "$s durability $c ($mode): $r"
  done
  docker rm -f "s3-$s" >/dev/null; docker volume rm "$vol" >/dev/null
}

environment() {
  node -e '
    const { execSync } = require("child_process");
    const sh = (c) => { try { return execSync(c, { encoding: "utf8" }).trim(); } catch { return null; } };
    const digest = (img) => sh(`docker image inspect ${img} --format "{{index .RepoDigests 0}}"`) ?? sh(`docker image inspect ${img} --format "{{.Id}}"`);
    const lock = JSON.parse(require("fs").readFileSync("package-lock.json", "utf8")).packages;
    const [rustfs, seaweedfs, minioImage, minioTag, client] = process.argv.slice(1);
    console.log(JSON.stringify({
      date: new Date().toISOString(),
      host: { os: `macOS ${sh("sw_vers -productVersion")}`, model: sh("sysctl -n hw.model"), cpu: sh("sysctl -n machdep.cpu.brand_string"), memGiB: +(sh("sysctl -n hw.memsize") / 2 ** 30).toFixed(0) },
      docker: { version: sh("docker version --format {{.Server.Version}}"), vmCpus: +sh("docker info --format {{.NCPU}}"), vmMemGiB: +(sh("docker info --format {{.MemTotal}}") / 2 ** 30).toFixed(1), kernel: sh("docker info --format {{.KernelVersion}}") },
      stores: {
        rustfs: { image: rustfs, digest: digest(rustfs), mode: "default single-node (single drive)" },
        seaweedfs: { image: seaweedfs, digest: digest(seaweedfs), mode: "weed mini (all-in-one dev mode)" },
        minio: { tag: minioTag, commit: sh(`docker run --rm --entrypoint cat ${minioImage} /minio.commit`), build: "built from source (stores/minio/Dockerfile)", mode: "server /data (single drive)" },
      },
      client: { image: client, digest: digest(client), node: sh("docker exec s3-client node --version"), awsSdkClientS3: lock["node_modules/@aws-sdk/client-s3"].version },
      workload: { data: "random (incompressible)", small: "500 x 64 KiB, 16 concurrent", medium: "40 x 8 MiB, 4 concurrent", multipart: "256 MiB in 16 MiB parts, 4 concurrent" },
    }, null, 2));
  ' "$RUSTFS_IMAGE" "$SEAWEEDFS_IMAGE" "$MINIO_IMAGE" "$MINIO_TAG" "$CLIENT_IMAGE" > results/environment.json
}

setup
environment
for i in $(seq 1 "$ITERATIONS"); do
  # rotate the order each iteration: R S M, S M R, M R S, ...
  n=${#STORES[@]}; for k in $(seq 0 $((n - 1))); do
    s=${STORES[$(( (k + i - 1) % n ))]}
    perf_run "$s" "$i"
    sleep "$COOLDOWN"
  done
done
for s in "${STORES[@]}"; do durability "$s"; done
docker rm -f s3-client >/dev/null
node bench/report.mjs
