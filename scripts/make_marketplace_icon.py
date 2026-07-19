"""Create marketplace icon: white background with black CodeSensei logo.

The marketplace displays the package.json `icon` PNG on top of
`galleryBanner.color`. A single PNG is used (no theme variants).
White bg + black fg gives strong contrast on the dark navy banner
and reads cleanly on light marketplace pages too.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "logo.png"  # black-on-transparent source
OUT = ROOT / "media" / "codesensei-marketplace.png"
SIZE = 512  # marketplace recommends 256x256, but higher res scales better


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"source not found: {SRC}")

    src = Image.open(SRC).convert("RGBA")
    src = src.resize((SIZE, SIZE), Image.LANCZOS)
    arr = np.asarray(src)

    # alpha channel defines the logo silhouette
    alpha = arr[:, :, 3]

    # Build opaque white background, paint logo pixels black.
    out = np.full((SIZE, SIZE, 4), 255, dtype=np.uint8)
    out[:, :, 3] = 255  # fully opaque
    # Where the source had any alpha, paint black.
    out[alpha > 16, :3] = 0

    Image.fromarray(out, "RGBA").save(OUT, "PNG")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
