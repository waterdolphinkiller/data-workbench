#!/usr/bin/env python3
"""
Render cinema-grade Obsidian & Warm Champagne launch video (MP4 1280x720 30fps + ambient audio)
and palette-optimized GitHub README GIF (960x540 15fps) for Data Workbench 2.4.
"""
import math
import os
import subprocess
import tempfile
import wave
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1280, 720
FPS = 30
DURATION = 16.0
TOTAL_FRAMES = int(FPS * DURATION)

# Luxury Obsidian & Warm Champagne Palette
BG_0 = (8, 9, 12)
BG_1 = (16, 18, 23)
BG_2 = (22, 25, 32)
BORDER = (46, 48, 56)
BORDER_GOLD = (140, 122, 92)
TEXT_0 = (243, 241, 236)
TEXT_1 = (164, 162, 156)
TEXT_2 = (111, 110, 105)
GOLD = (203, 180, 142)
GOLD_BRIGHT = (245, 224, 182)
EMERALD = (52, 168, 112)
AMBER = (207, 160, 76)
CARMINE = (207, 92, 92)

FONT_SERIF = "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"
FONT_SERIF_IT = "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf"
FONT_SANS = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
FONT_SANS_B = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"
FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

FONTS = {}
def font(path, size):
    key = (path, size)
    if key not in FONTS:
        FONTS[key] = ImageFont.truetype(path, size)
    return FONTS[key]

def clamp(x, a=0.0, b=1.0):
    return a if x < a else (b if x > b else x)

def ease_out_cubic(x):
    x = clamp(x)
    return 1.0 - (1.0 - x) ** 3

def ease_in_out(x):
    x = clamp(x)
    return x * x * (3.0 - 2.0 * x)

def lerp_color(c1, c2, t):
    t = clamp(t)
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
    )

def alpha_color(rgb, a):
    return (rgb[0], rgb[1], rgb[2], int(clamp(a) * 255))

# Precompute subtle architectural dot-grid + obsidian vignette base (super fast per-frame copy)
def build_base_canvas():
    arr = np.zeros((H, W, 3), dtype=np.uint8)
    arr[:, :] = BG_0
    # Subtle radial glow from top-center
    yy, xx = np.mgrid[0:H, 0:W]
    dx = (xx - W * 0.5) / (W * 0.55)
    dy = (yy - H * 0.36) / (H * 0.65)
    dist2 = dx * dx + dy * dy
    glow = np.exp(-dist2 * 1.45)
    arr[:, :, 0] = np.clip(arr[:, :, 0] + glow * 26, 0, 255).astype(np.uint8)
    arr[:, :, 1] = np.clip(arr[:, :, 1] + glow * 22, 0, 255).astype(np.uint8)
    arr[:, :, 2] = np.clip(arr[:, :, 2] + glow * 16, 0, 255).astype(np.uint8)
    # Subtle dot matrix every 32px
    arr[16::32, 16::32] = np.clip(arr[16::32, 16::32].astype(np.int16) + 18, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")

BASE_BG = build_base_canvas()

# Pre-seeded deterministic particles for Act 1 & Act 5
RNG = np.random.default_rng(42)
SHARDS = []
for i in range(96):
    row = i % 8
    SHARDS.append({
        "x0": RNG.uniform(-80, W + 80),
        "speed": RNG.uniform(160, 290),
        "chaos_y": RNG.uniform(70, H - 70),
        "target_y": 140 + row * 62,
        "w_chaos": RNG.uniform(18, 52),
        "w_order": 58 + (row % 3) * 20,
        "hazard": (i % 7 == 0),
        "emerald": (i % 5 == 0),
        "phase": RNG.uniform(0, 6.28),
    })

def draw_rounded_box(draw, xy, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)

def draw_aperture(layer, cx, cy, r_outer, t, intensity=1.0):
    d = ImageDraw.Draw(layer, "RGBA")
    # Layered translucent volumetric optical halo (blended over RGB base)
    for mult, a in [(1.75, 0.025), (1.48, 0.04), (1.26, 0.055), (1.06, 0.075)]:
        rr = r_outer * mult
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=alpha_color(GOLD, a * intensity))
    # Subtle dark obsidian optical center so foreground serif headline has cinema contrast
    r_core = r_outer * 0.85
    d.ellipse([cx - r_core, cy - r_core, cx + r_core, cy + r_core], fill=alpha_color(BG_0, 0.52 * intensity))
    # Outer obsidian bezel + champagne bevel + inner brass ring
    d.ellipse([cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer],
              outline=alpha_color(GOLD_BRIGHT, 0.72 * intensity), width=3)
    r_in = r_outer * 0.88
    d.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in],
              outline=alpha_color(GOLD, 0.45 * intensity), width=2)
    r_hair = r_outer * 1.10
    d.ellipse([cx - r_hair, cy - r_hair, cx + r_hair, cy + r_hair],
              outline=alpha_color(GOLD, 0.22 * intensity), width=1)
    # 48 counter-rotating Swiss chronometer ticks
    for i in range(48):
        ang = (i / 48.0) * math.tau + t * 0.45
        major = (i % 4 == 0)
        r0 = r_outer * (0.89 if major else 0.92)
        r1 = r_outer * (1.03 if major else 0.99)
        x0, y0 = cx + math.cos(ang) * r0, cy + math.sin(ang) * r0
        x1, y1 = cx + math.cos(ang) * r1, cy + math.sin(ang) * r1
        d.line([x0, y0, x1, y1], fill=alpha_color(GOLD_BRIGHT if major else GOLD, (0.85 if major else 0.45) * intensity),
               width=2 if major else 1)

def draw_chrome_header(d, title_right, active_pill):
    # Subtle top bar inside video frame
    d.line([48, 58, W - 48, 58], fill=alpha_color(BORDER, 0.8), width=1)
    draw_rounded_box(d, [48, 22, 76, 50], 5, fill=alpha_color(GOLD, 0.14), outline=alpha_color(GOLD, 0.5), width=1)
    d.text((54, 29), "DW", fill=GOLD, font=font(FONT_MONO_B, 13))
    d.text((88, 28), "DATA WORKBENCH 2.4", fill=TEXT_0, font=font(FONT_SANS_B, 13))
    # Pill
    tw = d.textlength(active_pill, font=font(FONT_MONO, 12))
    px = W - 48 - tw - 26
    draw_rounded_box(d, [px, 24, W - 48, 48], 12, fill=alpha_color(BG_2, 0.95), outline=alpha_color(BORDER_GOLD, 0.55), width=1)
    d.ellipse([px + 10, 33, px + 16, 39], fill=EMERALD)
    d.text((px + 22, 29), active_pill, fill=GOLD, font=font(FONT_MONO, 12))

def draw_progress_bar(d, t):
    frac = clamp(t / DURATION)
    d.rectangle([0, H - 3, W, H], fill=BG_2)
    d.rectangle([0, H - 3, int(W * frac), H], fill=GOLD)

def render_act1(img, t, local_t):
    """0.0 - 3.2s: 3D Optical Aperture Sweep & Luxury Editorial Title Reveal"""
    d = ImageDraw.Draw(img, "RGBA")
    p = clamp(local_t / 3.2)
    ap_x = W * (0.28 + 0.24 * ease_in_out(p))
    ap_y = H * 0.50

    # Shards transitioning from chaos (left of aperture) to ordered columnar matrix (right)
    for s in SHARDS:
        x = (s["x0"] + t * s["speed"]) % (W + 160) - 80
        raw = clamp((x - (ap_x - 110)) / 220.0)
        e = ease_in_out(raw)
        y = s["target_y"] + (s["chaos_y"] - s["target_y"] + math.sin(t * 2.5 + s["phase"]) * 16) * (1.0 - e)
        w_bar = s["w_chaos"] + (s["w_order"] - s["w_chaos"]) * e
        h_bar = 7 + (1.0 - e) * 4
        forge = math.exp(-((x - ap_x) / 72.0) ** 2)

        src = CARMINE if s["hazard"] else AMBER
        dst = EMERALD if s["emerald"] else (GOLD if s["w_order"] > 70 else TEXT_0)
        col = lerp_color(src, dst, e)
        if forge > 0.08:
            col = lerp_color(col, GOLD_BRIGHT, forge * 0.8)
        alpha = 0.25 + 0.55 * e + 0.2 * forge
        draw_rounded_box(d, [x - w_bar * 0.5, y - h_bar * 0.5, x + w_bar * 0.5, y + h_bar * 0.5],
                         2, fill=alpha_color(col, alpha))

    # Ordered horizontal optical rails on right of aperture
    for r in range(8):
        ry = 140 + r * 62
        d.line([ap_x, ry, W - 40, ry], fill=alpha_color(GOLD, 0.14), width=1)

    draw_aperture(img, ap_x, ap_y, 178, t, intensity=0.95)

    # Dark vignette center card for crisp editorial serif readability
    fade_in = ease_out_cubic(local_t / 0.75)
    fade_out = 1.0 - ease_in_out((local_t - 2.65) / 0.55)
    vis = fade_in * fade_out
    if vis > 0.02:
        dy = int((1.0 - fade_in) * 22)
        # Eyebrow pill
        eyebrow = "LOCAL-FIRST  ·  ZERO UPLOADS  ·  MIT OPEN SOURCE"
        ew = d.textlength(eyebrow, font=font(FONT_MONO, 13))
        draw_rounded_box(d, [W/2 - ew/2 - 22, 186 + dy, W/2 + ew/2 + 22, 218 + dy], 16,
                         fill=alpha_color(BG_1, 0.88 * vis), outline=alpha_color(GOLD, 0.55 * vis), width=1)
        d.text((W/2 - ew/2, 194 + dy), eyebrow, fill=alpha_color(GOLD, vis), font=font(FONT_MONO, 13))

        # Main Serif Headline
        h1 = "Data Workbench 2.4"
        h1w = d.textlength(h1, font=font(FONT_SERIF, 82))
        d.text((W/2 - h1w/2, 246 + dy), h1, fill=alpha_color(TEXT_0, vis), font=font(FONT_SERIF, 82))

        h2 = "Order from chaotic data, 100% locally."
        h2w = d.textlength(h2, font=font(FONT_SERIF_IT, 38))
        d.text((W/2 - h2w/2, 344 + dy), h2, fill=alpha_color(GOLD_BRIGHT, vis), font=font(FONT_SERIF_IT, 38))

        sub = "CSV  ·  Multi-Sheet Excel (.xlsx)  ·  JSON  ·  Visual DAG  ·  CLI  ·  10-Tool MCP"
        sw = d.textlength(sub, font=font(FONT_SANS, 18))
        d.text((W/2 - sw/2, 418 + dy), sub, fill=alpha_color(TEXT_1, vis), font=font(FONT_SANS, 18))

def render_act2(img, t, local_t):
    """3.2 - 6.8s: Live Messy Data -> Optical Sweep -> Clean, Deduped & PII Masked"""
    d = ImageDraw.Draw(img, "RGBA")
    enter = ease_out_cubic(local_t / 0.55)
    leave = 1.0 - ease_in_out((local_t - 3.15) / 0.45)
    vis = enter * leave
    draw_chrome_header(d, "QUALITY RADAR", "01 · QUALITY RADAR & PII SENTINEL")

    # Section title
    ty = 84 + int((1 - enter) * 16)
    d.text((64, ty), "Clean messy CSV & Excel files without uploading a single byte.",
           fill=alpha_color(TEXT_0, vis), font=font(FONT_SERIF, 36))
    d.text((64, ty + 46), "Auto-detect dialects, fuzzy-cluster typos, guard CSV formula injection, and mask PII in one pass.",
           fill=alpha_color(TEXT_1, vis), font=font(FONT_SANS, 16))

    # Studio Table Card
    card_x0, card_y0, card_x1, card_y1 = 64, 176, W - 64, 598
    draw_rounded_box(d, [card_x0, card_y0, card_x1, card_y1], 12,
                     fill=alpha_color(BG_1, 0.96 * vis), outline=alpha_color(BORDER_GOLD, 0.45 * vis), width=1)

    # Top bar of card
    d.rectangle([card_x0 + 1, card_y0 + 1, card_x1 - 1, card_y0 + 44], fill=alpha_color(BG_2, 0.96 * vis))
    for idx, cx in enumerate([card_x0 + 22, card_x0 + 38, card_x0 + 54]):
        d.ellipse([cx - 4, card_y0 + 18, cx + 4, card_y0 + 26], outline=alpha_color(TEXT_2, vis), width=1)
    d.text((card_x0 + 78, card_y0 + 14), "q4_customers_raw.xlsx  →  Columnar Engine (TypedArray)",
           fill=alpha_color(TEXT_1, vis), font=font(FONT_MONO, 13))

    # Optical sweep progress (sweeps from 0.9s to 2.2s)
    sweep_p = ease_in_out((local_t - 0.85) / 1.25)
    sweep_x = card_x0 + 16 + sweep_p * (card_x1 - card_x0 - 32)

    status_txt = "CLEANSED · 0 BYTES UPLOADED" if sweep_p > 0.85 else ("CLEANING IN BROWSER..." if sweep_p > 0.05 else "5 ISSUES DETECTED")
    status_col = EMERALD if sweep_p > 0.85 else (GOLD if sweep_p > 0.05 else CARMINE)
    stw = d.textlength(status_txt, font=font(FONT_MONO_B, 12))
    draw_rounded_box(d, [card_x1 - stw - 36, card_y0 + 10, card_x1 - 14, card_y0 + 34], 12,
                     fill=alpha_color(status_col, 0.16 * vis), outline=alpha_color(status_col, 0.55 * vis), width=1)
    d.text((card_x1 - stw - 25, card_y0 + 15), status_txt, fill=alpha_color(status_col, vis), font=font(FONT_MONO_B, 12))

    # Table Headers
    cols = [("ORDER_ID", 88), ("COMPANY", 230), ("EMAIL (PII)", 475), ("DATE", 745), ("AMOUNT", 910), ("STATUS", 1045)]
    hy = card_y0 + 58
    for cname, cx in cols:
        d.text((cx, hy), cname, fill=alpha_color(TEXT_2, vis), font=font(FONT_MONO_B, 12))
    d.line([card_x0 + 16, hy + 24, card_x1 - 16, hy + 24], fill=alpha_color(BORDER, vis), width=1)

    rows_data = [
        ("ORD-1041", "  ACME Corp. ", "Acme Corp", "j.doe@acme.com", "j***@acme.com", "10/31/2026", "2026-10-31", "$14,200", "Trim + PII", "CLEAN"),
        ("ORD-1042", "acme  corp", "Acme Corp", "s.lin@acme.com", "s***@acme.com", "2026/11/02", "2026-11-02", "$8,950", "Fuzzy Cluster", "CLEAN"),
        ("ORD-1042", "ACME CORP", "(deduplicated)", "s.lin@acme.com", "—", "2026-11-02", "—", "$8,950", "Duplicate Key", "REMOVED"),
        ("ORD-1043", "=CMD|'calc'", "'=CMD|'calc'", "a.patel@nova.io", "a***@nova.io", "Nov 04 2026", "2026-11-04", "$22,400", "Formula Guard", "SAFE"),
        ("ORD-1044", "Northstar LLC", "Northstar LLC", "m.chen@ns.co", "m***@ns.co", "2026-11-05", "2026-11-05", "$19,100", "Verified", "CLEAN"),
    ]

    for idx, r in enumerate(rows_data):
        ry = hy + 42 + idx * 62
        d.line([card_x0 + 16, ry + 48, card_x1 - 16, ry + 48], fill=alpha_color(BORDER, 0.55 * vis), width=1)
        cleaned = sweep_p > (0.15 + idx * 0.14)
        oid, c_raw, c_ok, e_raw, e_ok, d_raw, d_ok, amt, tag_raw, tag_ok = r

        if cleaned and tag_ok == "REMOVED":
            row_alpha = 0.35 * vis
            d.text((88, ry + 10), oid, fill=alpha_color(TEXT_2, row_alpha), font=font(FONT_MONO, 14))
            d.text((230, ry + 10), "Deduplicated by primary key (ORD-1042)", fill=alpha_color(TEXT_2, 0.65 * vis), font=font(FONT_MONO, 14))
            draw_rounded_box(d, [1045, ry + 6, 1142, ry + 32], 12, fill=alpha_color(GOLD, 0.14 * vis))
            d.text((1061, ry + 12), "DEDUPED", fill=alpha_color(GOLD, vis), font=font(FONT_MONO_B, 11))
            continue

        d.text((88, ry + 10), oid, fill=alpha_color(TEXT_0, vis), font=font(FONT_MONO, 14))
        d.text((230, ry + 10), c_ok if cleaned else c_raw,
               fill=alpha_color(EMERALD if cleaned else AMBER, vis), font=font(FONT_MONO, 14))
        d.text((475, ry + 10), e_ok if cleaned else e_raw,
               fill=alpha_color(GOLD_BRIGHT if cleaned else CARMINE, vis), font=font(FONT_MONO, 14))
        d.text((745, ry + 10), d_ok if cleaned else d_raw,
               fill=alpha_color(TEXT_0 if cleaned else AMBER, vis), font=font(FONT_MONO, 14))
        d.text((910, ry + 10), amt, fill=alpha_color(TEXT_0, vis), font=font(FONT_MONO, 14))

        badge_txt = tag_ok if cleaned else tag_raw
        bcol = EMERALD if cleaned else (CARMINE if idx in (2, 3) else AMBER)
        draw_rounded_box(d, [1045, ry + 6, 1185, ry + 32], 12, fill=alpha_color(bcol, 0.16 * vis))
        d.text((1058, ry + 12), badge_txt, fill=alpha_color(bcol, vis), font=font(FONT_MONO_B, 11))

    # Glowing vertical optical laser sweep bar
    if 0.02 < sweep_p < 0.98:
        for dx, a in [(-24, 0.05), (-12, 0.12), (-4, 0.25), (0, 0.95), (4, 0.25), (12, 0.12)]:
            d.line([sweep_x + dx, card_y0 + 46, sweep_x + dx, card_y1 - 8],
                   fill=alpha_color(GOLD_BRIGHT, a * vis), width=3 if dx == 0 else 6)

    # Bottom metrics strip
    d.text((64, 624), "✓ OpenRefine-style Fingerprint + Levenshtein Clustering   ✓ Formula Injection Guard   ✓ Instant Undo/Redo Recorder",
           fill=alpha_color(TEXT_1, vis), font=font(FONT_MONO, 13))

def render_act3(img, t, local_t):
    """6.8 - 10.2s: Visual Multi-Port DAG Pipeline & Primary-Key Diff"""
    d = ImageDraw.Draw(img, "RGBA")
    enter = ease_out_cubic(local_t / 0.55)
    leave = 1.0 - ease_in_out((local_t - 2.95) / 0.45)
    vis = enter * leave
    draw_chrome_header(d, "DAG STUDIO", "02 · VISUAL MULTI-PORT DAG & KEY DIFF")

    ty = 84 + int((1 - enter) * 16)
    d.text((64, ty), "Wire multi-sheet joins, fuzzy merges, and primary-key diffs.",
           fill=alpha_color(TEXT_0, vis), font=font(FONT_SERIF, 36))
    d.text((64, ty + 46), "32 deterministic versioned nodes with named out / errors ports — exportable to Git & CI.",
           fill=alpha_color(TEXT_1, vis), font=font(FONT_SANS, 16))

    # DAG Stage box
    sx0, sy0, sx1, sy1 = 64, 176, W - 64, 520
    draw_rounded_box(d, [sx0, sy0, sx1, sy1], 12,
                     fill=alpha_color(BG_1, 0.96 * vis), outline=alpha_color(BORDER_GOLD, 0.42 * vis), width=1)

    nodes = [
        ("source.xlsx", "Q4_Sales.xlsx · Sheet 'Orders'", 98, 224, GOLD),
        ("source.csv", "CRM_Accounts.csv · 48k rows", 98, 372, GOLD),
        ("transform.merge", "Left Join on account_id", 420, 298, EMERALD),
        ("clean.clusterMerge", "Fuzzy Company Normalizer", 726, 232, GOLD_BRIGHT),
        ("diff.table", "Primary-Key Cell Diff · Report", 726, 374, EMERALD),
        ("output.xlsx", "Clean + Audit Workbook", 1018, 298, TEXT_0),
    ]

    # Draw smooth cubic bezier conduits with animated golden light pulses
    edges = [
        ((296, 266), (420, 330)),
        ((296, 414), (420, 350)),
        ((618, 330), (726, 274)),
        ((618, 348), (726, 416)),
        ((924, 274), (1018, 330)),
        ((924, 416), (1018, 350)),
    ]

    for ei, ((x0, y0), (x1, y1)) in enumerate(edges):
        cx0, cy0 = x0 + (x1 - x0) * 0.55, y0
        cx1, cy1 = x1 - (x1 - x0) * 0.55, y1
        pts = []
        steps = 28
        for k in range(steps + 1):
            u = k / steps
            bx = (1-u)**3 * x0 + 3*(1-u)**2 * u * cx0 + 3*(1-u)*u**2 * cx1 + u**3 * x1
            by = (1-u)**3 * y0 + 3*(1-u)**2 * u * cy0 + 3*(1-u)*u**2 * cy1 + u**3 * y1
            pts.append((bx, by))
        d.line(pts, fill=alpha_color(BORDER_GOLD, 0.55 * vis), width=2)

        # Animated light packet racing along conduit
        u_pkt = (local_t * 0.72 + ei * 0.21) % 1.0
        px = (1-u_pkt)**3 * x0 + 3*(1-u_pkt)**2 * u_pkt * cx0 + 3*(1-u_pkt)*u_pkt**2 * cx1 + u_pkt**3 * x1
        py = (1-u_pkt)**3 * y0 + 3*(1-u_pkt)**2 * u_pkt * cy0 + 3*(1-u_pkt)*u_pkt**2 * cy1 + u_pkt**3 * y1
        d.ellipse([px - 9, py - 9, px + 9, py + 9], fill=alpha_color(GOLD, 0.28 * vis))
        d.ellipse([px - 4, py - 4, px + 4, py + 4], fill=alpha_color(GOLD_BRIGHT, 0.95 * vis))

    # Draw Nodes
    for name, sub, nx, ny, accent in nodes:
        nw, nh = 198, 84
        draw_rounded_box(d, [nx, ny, nx + nw, ny + nh], 9,
                         fill=alpha_color(BG_2, 0.98 * vis), outline=alpha_color(accent, 0.6 * vis), width=1)
        d.ellipse([nx + 14, ny + 18, nx + 22, ny + 26], fill=alpha_color(accent, vis))
        d.text((nx + 30, ny + 14), name, fill=alpha_color(TEXT_0, vis), font=font(FONT_MONO_B, 13))
        d.text((nx + 14, ny + 44), sub, fill=alpha_color(TEXT_1, vis), font=font(FONT_SANS, 12))
        # Ports
        d.ellipse([nx - 4, ny + nh/2 - 4, nx + 4, ny + nh/2 + 4], fill=alpha_color(GOLD, vis))
        d.ellipse([nx + nw - 4, ny + nh/2 - 4, nx + nw + 4, ny + nh/2 + 4], fill=alpha_color(EMERALD, vis))

    # Bottom Diff Summary Card
    draw_rounded_box(d, [64, 544, W - 64, 650], 10,
                     fill=alpha_color(BG_1, 0.96 * vis), outline=alpha_color(BORDER, vis), width=1)
    d.text((90, 564), "PRIMARY-KEY DIFF SUMMARY  (v1_export.csv  vs  v2_export.csv)",
           fill=alpha_color(TEXT_2, vis), font=font(FONT_MONO_B, 12))
    badges = [("+142 ADDED", EMERALD, 90), ("18 CELL-LEVEL MODIFIED", AMBER, 260), ("3 REMOVED", CARMINE, 535), ("0 SCHEMA DRIFT", GOLD, 700)]
    for btxt, bcol, bx in badges:
        bw = d.textlength(btxt, font=font(FONT_MONO_B, 13)) + 28
        draw_rounded_box(d, [bx, 594, bx + bw, 628], 6,
                         fill=alpha_color(bcol, 0.14 * vis), outline=alpha_color(bcol, 0.55 * vis), width=1)
        d.text((bx + 14, 604), btxt, fill=alpha_color(bcol, vis), font=font(FONT_MONO_B, 13))

def render_act4(img, t, local_t):
    """10.2 - 13.4s: Verified 100k Columnar Speed + AI-Native 10-Tool MCP"""
    d = ImageDraw.Draw(img, "RGBA")
    enter = ease_out_cubic(local_t / 0.55)
    leave = 1.0 - ease_in_out((local_t - 2.75) / 0.45)
    vis = enter * leave
    draw_chrome_header(d, "ENGINE & MCP", "03 · COLUMNAR SPEED & AI-NATIVE MCP")

    ty = 84 + int((1 - enter) * 16)
    d.text((64, ty), "100,000 rows in milliseconds. Built for humans and AI agents.",
           fill=alpha_color(TEXT_0, vis), font=font(FONT_SERIF, 36))
    d.text((64, ty + 46), "Zero-copy Selection-Vector columnar engine paired with a 10-tool sandboxed MCP server.",
           fill=alpha_color(TEXT_1, vis), font=font(FONT_SANS, 16))

    # Left Card: Verified Benchmarks (100k x 25, 12.74 MB CSV)
    lx0, ly0, lx1, ly1 = 64, 182, 620, 626
    draw_rounded_box(d, [lx0, ly0, lx1, ly1], 12,
                     fill=alpha_color(BG_1, 0.96 * vis), outline=alpha_color(BORDER_GOLD, 0.45 * vis), width=1)
    d.text((lx0 + 26, ly0 + 24), "VERIFIED COLUMNAR BENCHMARK", fill=alpha_color(GOLD, vis), font=font(FONT_MONO_B, 12))
    d.text((lx0 + 26, ly0 + 48), "100,000 rows × 25 cols (12.74 MB CSV)", fill=alpha_color(TEXT_0, vis), font=font(FONT_SANS_B, 18))
    d.text((lx0 + 26, ly0 + 76), "Node v18 · 25.14 MB Est. RAM · 20 TypedArray + 4 Dict cols",
           fill=alpha_color(TEXT_2, vis), font=font(FONT_MONO, 12))

    bars = [
        ("Predicate Filter (Selection Vector)", "8.7 ms", 0.16, EMERALD),
        ("Primary-Key Deduplicate", "26.5 ms", 0.34, GOLD_BRIGHT),
        ("CSV Export + Formula Guard", "124.8 ms", 0.64, GOLD),
        ("Full 25-Column Quality Profile", "262.7 ms", 0.88, AMBER),
    ]
    bar_anim = ease_out_cubic((local_t - 0.35) / 1.1)
    for idx, (lbl, val, frac, col) in enumerate(bars):
        by = ly0 + 132 + idx * 74
        d.text((lx0 + 26, by), lbl, fill=alpha_color(TEXT_1, vis), font=font(FONT_SANS, 14))
        vw = d.textlength(val, font=font(FONT_MONO_B, 15))
        d.text((lx1 - 26 - vw, by), val, fill=alpha_color(col, vis), font=font(FONT_MONO_B, 15))
        # Track & fill
        d.rounded_rectangle([lx0 + 26, by + 28, lx1 - 26, by + 40], radius=5, fill=alpha_color(BG_2, vis))
        fw = int((lx1 - lx0 - 52) * frac * bar_anim)
        if fw > 6:
            d.rounded_rectangle([lx0 + 26, by + 28, lx0 + 26 + fw, by + 40], radius=5, fill=alpha_color(col, 0.9 * vis))

    # Right Card: AI-Native MCP Terminal
    rx0, ry0, rx1, ry1 = 656, 182, W - 64, 626
    draw_rounded_box(d, [rx0, ry0, rx1, ry1], 12,
                     fill=alpha_color(BG_1, 0.96 * vis), outline=alpha_color(BORDER_GOLD, 0.45 * vis), width=1)
    d.text((rx0 + 26, ry0 + 24), "AI-NATIVE MCP & OPENAPI 3.1", fill=alpha_color(GOLD, vis), font=font(FONT_MONO_B, 12))
    d.text((rx0 + 26, ry0 + 48), "Zero-dependency local stdio server", fill=alpha_color(TEXT_0, vis), font=font(FONT_SANS_B, 18))

    # Terminal box
    draw_rounded_box(d, [rx0 + 24, ry0 + 96, rx1 - 24, ry1 - 24], 8,
                     fill=alpha_color(BG_0, 0.98 * vis), outline=alpha_color(BORDER, vis), width=1)

    cmd_full = "$ npx data-workbench-mcp --sandbox ./data"
    n_chars = int(clamp((local_t - 0.15) / 0.85) * len(cmd_full))
    d.text((rx0 + 42, ry0 + 118), cmd_full[:n_chars] + ("▌" if n_chars < len(cmd_full) else ""),
           fill=alpha_color(GOLD_BRIGHT, vis), font=font(FONT_MONO_B, 14))

    logs = [
        (0.95, "✓ Sandbox locked to ./data (path-traversal guard)", EMERALD),
        (1.15, "✓ PII redaction enabled on all tool responses", EMERALD),
        (1.35, "✓ 10 MCP Tools registered:", TEXT_0),
        (1.50, "  · inspect_file   · profile_dataset", TEXT_1),
        (1.62, "  · compile_plan   · preview_transform", TEXT_1),
        (1.74, "  · run_workflow   · compare_files", TEXT_1),
        (1.86, "  · validate_schema · get_run_report", TEXT_1),
        (2.05, "✓ Fuzzy aliases & didYouMean recovery ready", GOLD),
    ]
    for idx, (t_show, line, col) in enumerate(logs):
        if local_t >= t_show:
            la = ease_out_cubic((local_t - t_show) / 0.25) * vis
            d.text((rx0 + 42, ry0 + 158 + idx * 30), line, fill=alpha_color(col, la), font=font(FONT_MONO, 13))

def render_act5(img, t, local_t):
    """13.4 - 16.0s: Grand Finale End-Card"""
    d = ImageDraw.Draw(img, "RGBA")
    enter = ease_out_cubic(local_t / 0.65)
    draw_aperture(img, W * 0.5, H * 0.45, 220, t, intensity=0.85 * enter)

    dy = int((1 - enter) * 18)
    title = "Data Workbench 2.4"
    tw = d.textlength(title, font=font(FONT_SERIF, 76))
    d.text((W/2 - tw/2, 232 + dy), title, fill=alpha_color(TEXT_0, enter), font=font(FONT_SERIF, 76))

    sub = "Browser Studio  ·  dw CLI  ·  10-Tool MCP  ·  OpenAPI 3.1"
    sw = d.textlength(sub, font=font(FONT_SANS, 20))
    d.text((W/2 - sw/2, 332 + dy), sub, fill=alpha_color(GOLD_BRIGHT, enter), font=font(FONT_SANS, 20))

    # CTA Pill
    url_txt = "github.com/waterdolphinkiller/data-workbench"
    uw = d.textlength(url_txt, font=font(FONT_MONO_B, 16))
    draw_rounded_box(d, [W/2 - uw/2 - 28, 396 + dy, W/2 + uw/2 + 28, 444 + dy], 24,
                     fill=alpha_color(BG_1, 0.92 * enter), outline=alpha_color(GOLD, 0.75 * enter), width=1)
    d.text((W/2 - uw/2, 411 + dy), url_txt, fill=alpha_color(TEXT_0, enter), font=font(FONT_MONO_B, 16))

    foot = "100% Local-First  ·  Zero Dependencies  ·  MIT License"
    fw = d.textlength(foot, font=font(FONT_MONO, 13))
    d.text((W/2 - fw/2, 476 + dy), foot, fill=alpha_color(TEXT_2, enter), font=font(FONT_MONO, 13))

def synthesize_ambient_audio(wav_path):
    """Minimal, warm Obsidian cinema ambient chord + soft harmonic scene chimes."""
    sr = 44100
    n = int(sr * DURATION)
    tt = np.linspace(0.0, DURATION, n, endpoint=False)
    # Warm D-minor9 / Lydian luxury pad (D2, A2, F#3, C#4, E4)
    freqs = [73.42, 110.0, 185.0, 277.18, 329.63]
    amps = [0.22, 0.16, 0.10, 0.06, 0.045]
    sig = np.zeros(n, dtype=np.float64)
    for f, a in zip(freqs, amps):
        lfo = 0.85 + 0.15 * np.sin(2 * np.pi * 0.22 * tt + f * 0.05)
        sig += a * lfo * np.sin(2 * np.pi * f * tt)

    # Gentle crystalline chimes at Act transitions (0.2s, 3.3s, 6.9s, 10.3s, 13.5s)
    chimes = [(0.2, 587.33), (3.3, 659.25), (6.9, 739.99), (10.3, 880.0), (13.5, 1174.66)]
    for t0, cf in chimes:
        mask = tt >= t0
        dt = tt[mask] - t0
        env = np.exp(-dt * 2.6) * (1.0 - np.exp(-dt * 45.0))
        sig[mask] += 0.09 * env * (np.sin(2 * np.pi * cf * dt) + 0.35 * np.sin(2 * np.pi * cf * 2.0 * dt))

    # Smooth fade-in and fade-out
    fade_in = np.clip(tt / 0.8, 0.0, 1.0)
    fade_out = np.clip((DURATION - tt) / 1.4, 0.0, 1.0)
    sig *= fade_in * fade_out
    sig = np.clip(sig * 0.72, -0.95, 0.95)
    pcm = (sig * 32767).astype(np.int16)
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())

def main():
    out_dir = Path("../../output")
    out_mp4 = out_dir / "data-workbench-demo.mp4"
    out_gif = out_dir / "data-workbench-demo.gif"
    repo_gif = Path("assets/demo.gif")
    preview_dir = Path("/tmp/dw_video_previews")
    preview_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        wav_path = tmp_path / "ambient.wav"
        synthesize_ambient_audio(wav_path)

        # Pipe raw RGBA frames directly into ffmpeg for fast H.264 MP4 encoding
        cmd = [
            "ffmpeg", "-y",
            "-f", "rawvideo", "-vcodec", "rawvideo",
            "-s", f"{W}x{H}", "-pix_fmt", "rgb24", "-r", str(FPS),
            "-i", "-",
            "-i", str(wav_path),
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "128k", "-shortest",
            str(out_mp4)
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        sample_frames = {45: "act1.png", 160: "act2.png", 255: "act3.png", 365: "act4.png", 445: "act5.png"}

        for f in range(TOTAL_FRAMES):
            t = f / FPS
            img = BASE_BG.copy()
            if t < 3.2:
                render_act1(img, t, t)
            elif t < 6.8:
                render_act2(img, t, t - 3.2)
            elif t < 10.2:
                render_act3(img, t, t - 6.8)
            elif t < 13.4:
                render_act4(img, t, t - 10.2)
            else:
                render_act5(img, t, t - 13.4)

            draw_progress_bar(ImageDraw.Draw(img, "RGBA"), t)
            rgb = img
            if f in sample_frames:
                rgb.save(preview_dir / sample_frames[f])
            proc.stdin.write(rgb.tobytes())

        proc.stdin.close()
        stderr = proc.stderr.read().decode("utf-8", errors="ignore")
        ret = proc.wait()
        assert ret == 0, f"ffmpeg MP4 failed: {stderr[-600:]}"

        # Generate crisp 2-pass palette-optimized GIF (960x540 @ 14fps) for GitHub README & social sharing
        palette = tmp_path / "palette.png"
        subprocess.run([
            "ffmpeg", "-y", "-i", str(out_mp4),
            "-vf", "fps=14,scale=960:-1:flags=lanczos,palettegen=max_colors=192:stats_mode=diff",
            str(palette)
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run([
            "ffmpeg", "-y", "-i", str(out_mp4), "-i", str(palette),
            "-lavfi", "fps=14,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a",
            str(out_gif)
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Sync upgraded GIF into repo assets/demo.gif
    repo_gif.write_bytes(out_gif.read_bytes())
    print(f"MP4 ready: {out_mp4} ({out_mp4.stat().st_size / 1024:.1f} KB)")
    print(f"GIF ready: {out_gif} ({out_gif.stat().st_size / 1024:.1f} KB)")

if __name__ == "__main__":
    main()
