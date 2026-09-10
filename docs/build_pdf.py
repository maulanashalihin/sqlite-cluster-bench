"""Build docs/laporan-riset.pdf from inline HTML + charts via WeasyPrint."""
import pathlib
from weasyprint import HTML

ROOT = pathlib.Path(__file__).resolve().parent.parent
CH = ROOT / "charts"

def svg(name):
    return (CH / name).read_text()

CSS = """
@page { size: A4; margin: 22mm 18mm; @bottom-center { content: counter(page); font-size: 9pt; color: #666; } }
body { font-family: sans-serif; font-size: 10.5pt; line-height: 1.5; color: #111; }
h1 { font-size: 20pt; margin-bottom: 2mm; }
h2 { font-size: 13pt; color: #1d4ed8; border-bottom: 1px solid #ddd; padding-bottom: 2mm; margin-top: 8mm; }
table { border-collapse: collapse; width: 100%; margin: 3mm 0; font-size: 9.5pt; }
th, td { border: 1px solid #bbb; padding: 1.6mm 2.2mm; text-align: right; }
th:first-child, td:first-child { text-align: left; }
th { background: #eff6ff; }
tr:nth-child(even) td { background: #f8fafc; }
td.hl { background: #fef2f2; font-weight: bold; }
.meta { color: #444; font-size: 9.5pt; }
.cover { text-align: center; margin-top: 38mm; }
.cover .date { color: #555; margin-top: 6mm; }
svg { width: 100%; height: auto; }
ul tight li, li { margin-bottom: 1.2mm; }
pre { background: #f1f5f9; padding: 3mm; font-size: 8.5pt; }
.pagebreak { page-break-before: always; }
"""

T = f"""<html><head><meta charset="utf-8"><style>{CSS}</style></head><body>
<div class="cover">
<h1>SQLite vs Postgres:<br>single vs cluster HTTP benchmark</h1>
<p>Riset empiris degradasi persentil WAL SQLite pada Go Fiber dan Bun reusePort,
serta rekomendasi arsitektur production untuk aplikasi read-heavy single-server.</p>
<p class="date">10 September 2026 &middot; Data &amp; kode: github.com/maulanashalihin/sqlite-cluster-bench</p>
</div>

<h2>1. Ringkasan eksekutif</h2>
<ol>
<li><b>Bun cluster mengalami hal serupa — tail write lebih lebar.</b> Penyebabnya bukan
goroutine, melainkan satu WAL write-lock SQLite: 6 proses berebut gembok lintas-proses.</li>
<li><b>Single event-loop = antrean single-writer gratis</b> (write p99 5,5ms vs 35,0ms cluster-1-file).</li>
<li><b>reusePort obat pintu, bukan dapur</b>: SQLite read +73%, PG c50 &minus;10%.</li>
<li><b>Sharding (1 worker 1 file)</b>: write +86%, tail rata.</li>
<li><b>Postgres tanpa anomali tail</b> (gap p99 &le;1,5x); crossover cluster di c150.</li>
<li><b>Rekomendasi: SQLite, 1 proses writer, WAL + synchronous NORMAL + busy_timeout 5000.</b></li>
</ol>

<h2>2. Metodologi</h2>
<p class="meta">Mesin 6 CPU / RAM 11,7 GB Ubuntu &middot; Go 1.27.0, Fiber v2.52.9,
mattn/go-sqlite3 v1.14.32 (CGo), pgx v5.11.0 &middot; Bun 1.4.0 &middot; Postgres 18.6 &middot;
Skema <i>kv(id PK AUTOINCREMENT, val TEXT 100B)</i>, seed 20.000 &middot;
SQLite: WAL, synchronous NORMAL, busy_timeout 5000 &middot;
Endpoint POST /write (1 INSERT) dan GET /read?id= (point lookup) &middot;
Semua run fail=0. Semua angka = mean 3&ndash;5 iterasi.</p>

<h2>3. E1 &mdash; Fiber+mattn vs Bun cluster, write (20k, c50, 5 iterasi)</h2>
{svg("write-p99.svg")}
<table><tr><th></th><th>rps</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr>
<tr><td>READ Fiber</td><td>46.300</td><td>0,92</td><td>2,25</td><td>4,06</td><td>15,1</td></tr>
<tr><td>READ Bun 6w</td><td>51.372</td><td>0,82</td><td>1,68</td><td>2,92</td><td>8,3</td></tr>
<tr><td>WRITE Fiber</td><td>14.635</td><td>2,25</td><td>9,24</td><td>19,84</td><td>192,1</td></tr>
<tr><td>WRITE Bun 6w</td><td>15.149</td><td>1,04</td><td>12,60</td><td class="hl">35,59</td><td>103,0</td></tr>
</table>
<p>Range p99 write 5 ronde tak overlap (19,2&ndash;21,1 vs 34,1&ndash;37,9).
Median Bun 2x lebih baik, tail 1,8x lebih buruk: bimodal &mdash; jalur sepi kilat,
jalur tabrakan (lock + retry + checkpoint) dalam.</p>

<h2 class="pagebreak">4. E2 &mdash; Bun single vs cluster 1 file &middot; E3 &mdash; sharded 6 file</h2>
<table><tr><th>WRITE</th><th>rps</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr>
<tr><td>Single 1 file</td><td>20.411</td><td>2,23</td><td>3,97</td><td>5,49</td><td>13,6</td></tr>
<tr><td>Cluster 6w 1 file</td><td>15.557</td><td>0,73</td><td>12,67</td><td class="hl">34,95</td><td>145,7</td></tr>
<tr><td>Cluster 6w 6 file</td><td>39.082</td><td>1,07</td><td>2,63</td><td>5,19</td><td>15,4</td></tr>
</table>
<p>Single +31% throughput, p99 6x. Shard +86% vs single dengan tail rata &mdash;
perusak = jumlah writer per file. READ: cluster +73% (47.865 vs 27.568 rps).</p>

<h2>5. E4 &mdash; Postgres single vs cluster &middot; E5 &mdash; campuran 95/5</h2>
{svg("mixed-rps.svg")}
<table><tr><th>Mixed 95/5 (20k, c50)</th><th>rps</th><th>read p99</th><th>write p99</th></tr>
<tr><td>Bun SQLite single</td><td>25.436</td><td>5,21</td><td>5,42</td></tr>
<tr><td>Fiber PG single</td><td>19.500</td><td>6,98</td><td>7,44</td></tr>
<tr><td>Bun PG 6 worker</td><td>19.314</td><td>10,51</td><td>13,39</td></tr>
<tr><td>Bun PG single</td><td>12.665</td><td>8,00</td><td>8,19</td></tr>
</table>
<p>PG c50: single sedikit menang (bottleneck &plusmn;2ms/query; 60 koneksi cluster jadi
overhead). PG c150: cluster +25% read / +17% write &mdash; crossover saat accept-queue
jenuh. Di backend sama, Fiber single &asymp; Bun 6-worker, +55% atas Bun single.</p>

<h2>6. E6 &mdash; Kurva scaling worker (Bun+PG, mixed 95/5)</h2>
{svg("sweep.svg")}
<p>U-terbalik: 13.119 &rarr; <b>18.049</b> &rarr; 17.611 &rarr; 15.059 rps
(1/2/4/6 worker; max 50&rarr;210ms). Sweet spot 2 worker.</p>

<h2>7. Rekomendasi &amp; guardrail</h2>
<ol>
<li>SQLite, tepat 1 proses writer; Bun single atau Fiber+mattn.</li>
<li>Write batch dalam transaksi; busy_timeout 5000; monitor ukuran WAL + durasi checkpoint.</li>
<li>Sadari tradeoff synchronous NORMAL (jendela kecil kehilangan data saat OS crash).</li>
<li>Migrasi ke PG bila write &gt;20&ndash;30%, butuh failover, atau multi-node:
Fiber single atau Bun 2-worker (bukan 6).</li>
</ol>
<p class="meta">Batas riset: run detik (tanpa WAL-growth jangka panjang);
pool 10/worker arbitrer; payload 100B; satu mesin 6-CPU; Fiber+SQLite mixed belum diuji.
Reproduksi: lihat README repo.</p>
</body></html>"""

out = ROOT / "docs" / "laporan-riset.pdf"
out.parent.mkdir(exist_ok=True)
HTML(string=T).write_pdf(str(out))
print("wrote", out, out.stat().st_size, "bytes")
