#!/usr/bin/env python3
"""本地生成 dist/SHA256SUMS.txt（与 CI 同格式）：python tools/make_checksums.py [dist目录]"""
import hashlib
import sys
from pathlib import Path

def main():
    dist = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "app" / "dist"
    if not dist.is_dir():
        print(f"目录不存在: {dist}"); sys.exit(1)
    targets = sorted(p for p in dist.iterdir() if p.suffix.lower() in (".exe", ".zip") and p.is_file())
    if not targets:
        print("dist 里没有 .exe/.zip"); sys.exit(1)
    lines = []
    for p in targets:
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        lines.append(f"{h.hexdigest()}  {p.name}")
        print(lines[-1])
    out = dist / "SHA256SUMS.txt"
    out.write_text("\n".join(lines) + "\n", encoding="ascii")
    print(f"--> {out}")

if __name__ == "__main__":
    main()
