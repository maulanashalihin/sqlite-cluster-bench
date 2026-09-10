# Sharding SQLite + playbook vertical scaling (catatan belajar)

> Distilasi diskusi: dari "apa itu shard" sampai tangga 32-core. Test empiris:
> hash UUIDv7 100k → deviasi maks 1,27%; konsistensi lintas-proses 3/3 sama.

## 1. Shard = potongan data, core = pekerja

Sekolah 1000 murid, 4 ruang loker bertuliskan A–G / H–N / O–U / V–Z.
Budi (B) masuk Ruang 1 tanpa diberi tahu dan tanpa daftar tersimpan —
*tulisan di pintu + ejaannya sendiri sudah cukup.* Itulah seluruh logika shard:
**lokasi dihitung ulang tiap request dari kunci, bukan disimpan.**

## 2. Kunci shard: tenant_id, bukan nama, bukan UUID

- `shard = hash(tenant_id) % N` — deterministik, stateless, benar di semua
  mesin/restart/load-balancer tanpa sesi.
- Nama tampilan boleh berubah; **ID tak boleh** (immutable by design).
  Kalau ID harus ganti = pindahan rumah (copy → verifikasi → flip router).
- UUIDv7 = *identitas* (unik sedunia, anti tabrakan antar file).
  tenant = *alamat* (penentu file). Jangan shard pakai UUID:
  prefix timestamp-nya menumpukkan data baru di 1 shard.
- Hash (fnv-1a) mengacak sempurna: 100k UUIDv7 → 24977/24743/24962/25318.
  Keterurutan v7 tetap berguna di B-tree (insert cepat), tidak rusak oleh hash.

## 3. Bentuk fisik

- N file, **skema tabel identik**, isi beda (tiap file hanya tenant-nya).
- Query satu tenant = 1 file (cepat). Query lintas tenant = scatter-gather
  (buka N file, gabung di app — pajaknya ~2x, wajib jarang).
- Tabel tanpa tenant (setting global) = di-copy sama ke semua file.
- Tiap shard = unit serve mandiri: pola split 1 penulis + N pembaca,
  atau hook-mesh 3-node kalau butuh rangkap.

## 4. Router: fungsi 10 baris di aplikasi

```ts
const shards = [db("s0.db"), db("s1.db"), db("s2.db"), db("s3.db")];
const shardOf = (t: string) => hash(t) % 4;          // murni, tanpa state
query = shards[shardOf(tenant)].query(...);          // tulis & baca sama
```

Pengecualian (tenant raksasa → file khusus) via tabel override kecil
yang di-cache; 99% request tak menyentuhnya. Test kejujuran: matikan 1 file —
hanya tenant shard itu yang gagal.

## 5. Tambah shard = satu-satunya operasi mahal

`% 4` → `% 5` mengubah alamat mayoritas baris. Prosedur: buat file baru →
salin per peta baru → verifikasi count → flip pembagi (downtime hanya di sini)
→ buang yang lama. Trik murah: **over-shard sejak awal** (16 slot logis
dipetakan ke 4 file) — tambah file = pindah slot utuh, bukan rehash tiap baris.

## 6. Tangga vertical scaling (contoh 32 core baremetal)

```
4 file × (1 penulis + 5 pembaca) = 24 core + 8 cadangan (OS/spike/backup)
```

- Mentok 1 file → tambah pembaca (sampai lutut ~12–16, ukur via sweep).
- Mentok lutut → pecah file (tambah shard, pindah per slot).
- Mentok box → multi-server (hook-mesh per shard) atau PG.
- Naik tangga hanya saat metrik bunyi (p99 merangkak padahal CPU longgar,
  checkpoint stall naik) — bukan firasat.
- Belanja: RAM (cache) → NVMe IOPS → CPU secukupnya → kapasitas disk terakhir.
- NUMA: satu shard per socket (`taskset`/`numactl`); pastikan NIC multi-queue RSS.

## 7. Kapan TIDAK shard

Single server + litestream tetap benar selama: puncak < plafon box
(~20k tulis / ~45k baca per file), downtime menit–jam acceptable (litestream =
backup, bukan failover), dan belum ada user jauh / tabel TB-an.
Tiap shard/file tambahan = migrasi loop + backup + failure mode baru.

## Demo

`bench/shard-demo.js` — 4 file, 8 tenant, 4000 order: peta tenant→shard,
query per-tenant vs scatter-gather, audit isi file. Jalankan: `bun bench/shard-demo.js reset`.
(Catatan demo: 8 tenant bisa timpang — s0.db kosong. Produksi pakai ribuan
tenant atau range manual.)
