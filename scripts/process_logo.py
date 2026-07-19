"""
Process the CodeSensei logo PNG:
1. Remove white background -> transparent
2. Fix anti-aliasing halo (slight dark outline left after white removal)
3. Save transparent PNG at multiple sizes
4. Trace to SVG using cv2.findContours + curve smoothing
5. Save ICO for Windows app icon use
"""
import os
import math
import numpy as np
import cv2
from PIL import Image

SRC = r'D:\DEV\GITHUB_REPOS\codesensei\ChatGPT Image Jul 19, 2026, 09_06_14 PM.png'
OUT_DIR = r'D:\DEV\GITHUB_REPOS\codesensei\media'
ICON_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]


def contours_to_svg_paths(binary):
    """Trace binary bitmap (1=shape) to SVG path strings using cv2 contours.

    Uses RETR_CCOMP to capture holes (e.g. the question mark cutout inside
    the speech bubble). All paths are combined into a single <path> with
    fill-rule='evenodd' so holes are rendered correctly.
    """
    contours, hierarchy = cv2.findContours(
        binary.astype(np.uint8),
        cv2.RETR_CCOMP,        # 2-level hierarchy: outer + holes
        cv2.CHAIN_APPROX_TC89_KCOS,
    )
    if hierarchy is None or len(contours) == 0:
        return []
    hierarchy = hierarchy[0]  # shape: (N, 4) = [next, prev, child, parent]

    all_d = []
    for i, cnt in enumerate(contours):
        if len(cnt) < 3:
            continue
        epsilon = 0.002 * cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, epsilon, True)
        if len(approx) < 3:
            continue
        pts = approx.reshape(-1, 2).astype(float)
        d_parts = [f'M {pts[0][0]:.2f} {pts[0][1]:.2f}']
        for j in range(1, len(pts)):
            d_parts.append(f'L {pts[j][0]:.2f} {pts[j][1]:.2f}')
        d_parts.append('Z')
        all_d.append(' '.join(d_parts))

    # Combine all subpaths into ONE path string so fill-rule="evenodd"
    # applies to the whole set (outer shapes + holes together).
    combined = ' '.join(all_d)
    return [combined]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    img = Image.open(SRC).convert('RGBA')
    arr = np.array(img)
    rgb = arr[:, :, :3].astype(np.float32)
    h, w = arr.shape[:2]

    # --- 1. Remove white background + 2. Fix anti-aliasing halo ---
    gray = np.mean(rgb, axis=2)

    # Binary mask: True = black shape
    # Use threshold 128 for crisp separation, then morphological cleanup
    binary = gray < 128

    # Clean up: remove tiny specks (open) and fill tiny holes (close)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    binary_u8 = binary.astype(np.uint8)
    binary_u8 = cv2.morphologyEx(binary_u8, cv2.MORPH_OPEN, kernel)
    binary_u8 = cv2.morphologyEx(binary_u8, cv2.MORPH_CLOSE, kernel)
    binary = binary_u8.astype(bool)

    # Re-anti-alias the alpha channel from the crisp binary mask:
    # distance transform gives smooth alpha ramp at edges (~2px)
    dist_inner = cv2.distanceTransform(binary_u8, cv2.DIST_L2, 5)
    ramp = 1.5
    alpha_final = np.clip(dist_inner / ramp, 0, 1) * 255.0

    # RGB = pure black everywhere (shape area); transparent outside.
    # This ensures compositing over any background gives clean dark edges
    # with no gray halo.
    result = np.zeros((h, w, 4), dtype=np.uint8)
    result[:, :, 3] = alpha_final.astype(np.uint8)

    # Save full-res transparent PNG
    full_png = Image.fromarray(result, mode='RGBA')
    full_path = os.path.join(OUT_DIR, 'codesensei-logo.png')
    full_png.save(full_path)
    print(f'Saved {full_path} ({full_png.size})')

    # Save resized PNGs
    for size in ICON_SIZES:
        resized = full_png.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, f'codesensei-logo-{size}.png')
        resized.save(path)
        print(f'Saved {path}')

    # Save ICO (multi-size)
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_path = os.path.join(OUT_DIR, 'codesensei-logo.ico')
    full_png.save(ico_path, format='ICO', sizes=ico_sizes)
    print(f'Saved {ico_path}')

    # --- 4. Trace to SVG ---
    # Trace at full resolution for quality, then scale via viewBox
    paths = contours_to_svg_paths(binary_u8)

    svg_content = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {w} {h}" fill="currentColor" fill-rule="evenodd">\n'
    )
    for d in paths:
        svg_content += f'  <path d="{d}"/>\n'
    svg_content += '</svg>'

    svg_path = os.path.join(OUT_DIR, 'codesensei-logo.svg')
    with open(svg_path, 'w', encoding='utf-8') as f:
        f.write(svg_content)
    print(f'Saved {svg_path}')

    # VS Code activity bar icon: 16x16 viewBox, scaled via transform
    scale = 16.0 / w
    icon_svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" '
        f'fill="currentColor" fill-rule="evenodd">\n'
        f'  <g transform="scale({scale})">\n'
    )
    for d in paths:
        icon_svg += f'    <path d="{d}"/>\n'
    icon_svg += '  </g>\n</svg>'

    icon_path = os.path.join(OUT_DIR, 'icon.svg')
    with open(icon_path, 'w', encoding='utf-8') as f:
        f.write(icon_svg)
    print(f'Saved {icon_path} (16x16 viewBox for VS Code activity bar)')

    print('\nAll done!')


if __name__ == '__main__':
    main()
