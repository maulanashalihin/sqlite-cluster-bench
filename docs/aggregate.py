#!/usr/bin/env python3
"""Aggregate data/*.log (JSON-lines) into results/summary.json. Usage: python3 docs/aggregate.py"""
import json, glob, os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "data")
out = {}
for f in sorted(glob.glob(D + "/*.log")):
    name = os.path.basename(f)
    rows = []
    for line in open(f):
        line = line.strip()
        if line.startswith("{"):
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    if not rows:
        continue
    groups = defaultdict(list)
    for r in rows:
        groups[r.get("url", r.get("base", "?"))].append(r)
    out[name] = {}
    for k, g in groups.items():
        def stats(vals):
            return {"mean": round(sum(vals) / len(vals), 3),
                    "min": round(min(vals), 3), "max": round(max(vals), 3)} if vals else None
        e = {"n": len(g), "rps": stats([r["rps"] for r in g if "rps" in r]),
             "ok": sum(r.get("ok", 0) for r in g), "fail": sum(r.get("fail", 0) for r in g)}
        ops = [k2 for k2, v2 in g[0].items() if isinstance(v2, dict) and k2 not in ("lost_update",)]
        if ops:
            for op in ops:
                vv = defaultdict(list)
                for r in g:
                    for p, v in r.get(op, {}).items():
                        if isinstance(v, (int, float)):
                            vv[p].append(v)
                e[op] = {p: stats(v) for p, v in vv.items()}
        else:
            for p in ("avg_ms", "p50_ms", "p95_ms", "p99_ms", "max_ms"):
                e[p] = stats([r[p] for r in g if p in r])
        if isinstance(g[0].get("lost_update"), dict):
            e["lost_update"] = g[-1]["lost_update"]
        out[name][k] = e
dest = os.path.join(ROOT, "results", "summary.json")
json.dump(out, open(dest, "w"), indent=1)
print(f"wrote {dest} ({len(out)} experiments)")
