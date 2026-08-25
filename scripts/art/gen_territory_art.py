#!/usr/bin/env python3
"""Generate Territory's game art with nano-banana (Gemini `gemini-2.5-flash-image`).

One call per asset, nine in total: the eight board sprites the viewer draws plus
the TERRITORY wordmark. Raws land in `scripts/art/source/` (committed, so the
assets are reproducible rather than mysterious); `scripts/process-icons.py` turns
them into the 256px black-bg + alpha-keyed PNGs the client imports.

The key is NEVER printed, written to a file, or passed as a URL parameter — it is
the header `x-goog-api-key: $GEMINI_API_KEY` and nothing else.

    GEMINI_API_KEY=... python3 scripts/art/gen_territory_art.py [name ...]
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash-image:generateContent"
)
OUT = Path(__file__).resolve().parent / "source"

STYLE = (
    "Style: a single centered game icon, luminous neon-glass with a cyan (#3ce0c0) to "
    "magenta (#ff4d9d) gradient rim-light, soft outer glow, dark observatory / HUD "
    "aesthetic, crisp flat vector rendering, not photorealistic, no text, no labels, "
    "no border frame. Background: solid near-black charcoal #07070c, generous margin."
)

PROMPTS = {
    "wall": (
        "A game icon of a single low HEXAGONAL BLOCK of stacked stone bricks seen at a "
        "three-quarter angle — a thin, plain resource wall segment, intact, modest and "
        "unremarkable. " + STYLE
    ),
    "wall-rich": (
        "A game icon of a single tall HEXAGONAL BLOCK of stacked stone bricks seen at a "
        "three-quarter angle, intact and imposing, with three bright crystal veins glowing "
        "through the seams to say it is a RICH deposit. " + STYLE
    ),
    "cracked": (
        "A game icon of a single hexagonal block of stacked stone bricks, seen at a "
        "three-quarter angle, FRACTURED: a jagged split runs down the middle, the top "
        "course of bricks has slumped and chips of rubble sit at its foot. Damaged but "
        "still standing. " + STYLE
    ),
    "rubble": (
        "A game icon of a flat scatter of broken stone chips and grey dust filling a "
        "hexagonal footprint, seen from directly above — a wall that has been destroyed "
        "completely and is now a walkable floor. Nothing stands. Dim, inert, almost "
        "colourless compared to a glowing intact wall. " + STYLE
    ),
    "paint-splatter": (
        "A game icon of a single wet SPLATTER of thick luminous paint, an irregular blob "
        "with a few flung droplets around it, glossy and still dripping — a territorial "
        "claim mark just flung onto a surface. The whole square canvas, corner to corner, "
        "is solid near-black charcoal #07070c: NO white background, NO white circle, NO "
        "light panel or card behind the icon. " + STYLE
    ),
    "hearth": (
        "A game icon of a small round HEARTH: a ring of stones around a bright, contained "
        "flame, seen at a slight angle, with a faint protective halo ring drawn around the "
        "whole thing. A home site worth defending. " + STYLE
    ),
    "skull": (
        "A game icon of a small stylised robot SKULL — a rounded machine head with a dark "
        "cracked screen face and two dead pixel eyes, one antenna snapped off. Reads as "
        "'eliminated' at a glance. " + STYLE
    ),
    "logo": (
        "A game icon of a mechanical GEAR (a round toothed cog with a hollow centre) sitting "
        "inside a hexagon outline, the hexagon drawn as a thin luminous border. A compact "
        "app-icon lockup. " + STYLE
    ),
    "wordmark": (
        'A horizontal logo wordmark of the single word "TERRITORY" in bold all-capital '
        "letters, spelled exactly T-E-R-R-I-T-O-R-Y, where the single letter O is drawn as "
        "a mechanical gear / cog (a round toothed gear with a hole in the middle) in place "
        "of the O.\n\n"
        "Style: heavy geometric sans-serif letters with a luminous cyan-to-magenta "
        "neon-glass gradient (cyan #3ce0c0 flowing to magenta #ff4d9d), a soft outer glow, "
        "dark observatory / HUD aesthetic. Crisp, modern, high contrast.\n\n"
        "Centered horizontal lockup, generous margin. Background: solid near-black charcoal "
        "(#07070c). Correct spelling TERRITORY, no extra words, no other letters. Flat "
        "vector, not photorealistic."
    ),
}


def generate(name: str, prompt: str) -> bool:
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseModalities": ["IMAGE"]},
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode(),
        headers={
            "x-goog-api-key": os.environ["GEMINI_API_KEY"],
            "content-type": "application/json",
        },
    )
    try:
        resp = json.load(urllib.request.urlopen(req, timeout=180))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        print(f"  {name}: HTTP {exc.code} {detail}", file=sys.stderr)
        return False
    except Exception as exc:  # noqa: BLE001 - report and move on
        print(f"  {name}: {type(exc).__name__} {exc}", file=sys.stderr)
        return False
    parts = resp.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    blob = next((p["inlineData"]["data"] for p in parts if "inlineData" in p), None)
    if blob is None:
        print(f"  {name}: no image part in the response", file=sys.stderr)
        return False
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.png"
    path.write_bytes(base64.b64decode(blob))
    print(f"  {name} -> {path} ({path.stat().st_size} bytes)")
    return True


def main() -> int:
    wanted = sys.argv[1:] or list(PROMPTS)
    failed = []
    for name in wanted:
        prompt = PROMPTS.get(name)
        if prompt is None:
            print(f"  {name}: unknown asset", file=sys.stderr)
            failed.append(name)
            continue
        for attempt in range(2):
            if generate(name, prompt):
                break
            time.sleep(6 * (attempt + 1))
        else:
            failed.append(name)
    if failed:
        print(f"FAILED: {' '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
