from __future__ import annotations

import base64
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from tempfile import gettempdir

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path.cwd()
SVG_PATH = ROOT / "public" / "og-image.svg"
FAVICON_PATH = ROOT / "public" / "favicon.svg"
PNG_PATH = ROOT / "public" / "og-image.png"
WIDTH = 1200
HEIGHT = 630


def hex_to_rgba(value: str, alpha: float = 1.0) -> tuple[int, int, int, int]:
    value = value.strip().lstrip("#")
    return (
        int(value[0:2], 16),
        int(value[2:4], 16),
        int(value[4:6], 16),
        round(255 * alpha),
    )


def over(base: Image.Image, overlay: Image.Image) -> Image.Image:
    return Image.alpha_composite(base, overlay)


def extract_outfit_font() -> Path:
    svg = SVG_PATH.read_text(encoding="utf-8")
    match = re.search(r"base64,([A-Za-z0-9+/=]+)\) format\('woff2'\)", svg)
    if not match:
        raise RuntimeError("No embedded Outfit WOFF2 font found in public/og-image.svg")

    font_path = Path(gettempdir()) / "bellotreno-outfit-og.woff2"
    font_path.write_bytes(base64.b64decode(match.group(1)))
    return font_path


def outfit(font_path: Path, size: int, weight: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(font_path), size=size)
    font.set_variation_by_axes([weight])
    return font


def linear_gradient(size: tuple[int, int], start: tuple[int, int, int], end: tuple[int, int, int]) -> Image.Image:
    width, height = size
    image = Image.new("RGBA", size)
    pixels = image.load()
    for y in range(height):
        t = y / max(height - 1, 1)
        color = tuple(round(start[index] * (1 - t) + end[index] * t) for index in range(3))
        for x in range(width):
            pixels[x, y] = (*color, 255)
    return image


def radial_light(size: tuple[int, int]) -> Image.Image:
    width, height = size
    center_x = width * 0.5
    center_y = height * 0.24
    radius = width * 0.76
    stops = [
        (0.0, (237, 245, 248)),
        (0.55, (215, 227, 233)),
        (1.0, (184, 201, 211)),
    ]
    image = Image.new("RGBA", size)
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            t = min(math.hypot(x - center_x, y - center_y) / radius, 1.0)
            for index in range(len(stops) - 1):
                left, left_color = stops[index]
                right, right_color = stops[index + 1]
                if left <= t <= right:
                    local = (t - left) / (right - left)
                    color = tuple(round(left_color[i] * (1 - local) + right_color[i] * local) for i in range(3))
                    pixels[x, y] = (*color, 255)
                    break
    return image


def add_linear_overlay(base: Image.Image, color: tuple[int, int, int], max_alpha: float, direction: str) -> Image.Image:
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    pixels = overlay.load()
    width, height = base.size
    for y in range(height):
        for x in range(width):
            if direction == "warm":
                t = max(0.0, 1.0 - (x / width + y / height) / 0.68)
            else:
                t = max(0.0, ((x / width) + (1.0 - y / height) - 0.52) / 1.48)
            alpha = round(255 * max_alpha * min(t, 1.0))
            pixels[x, y] = (*color, alpha)
    return over(base, overlay)


def draw_shadowed_card(image: Image.Image) -> None:
    card = (255, 150, 945, 480)
    radius = 68
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    mask = Image.new("L", image.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((card[0], card[1] + 25, card[2], card[3] + 25), radius=radius, fill=round(255 * 0.24))
    shadow_color = Image.new("RGBA", image.size, hex_to_rgba("#3e5361", 1))
    shadow = Image.composite(shadow_color, shadow, mask).filter(ImageFilter.GaussianBlur(24))
    image.alpha_composite(shadow)

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(card, radius=radius, fill=hex_to_rgba("#edf4f8", 0.66), outline=hex_to_rgba("#ffffff", 0.86), width=2)


def tokenize_path(path_data: str) -> list[str]:
    return re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", path_data)


def cubic_point(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    t: float,
) -> tuple[float, float]:
    mt = 1 - t
    return (
        mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0],
        mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1],
    )


def vector_angle(start: tuple[float, float], end: tuple[float, float]) -> float:
    dot = start[0] * end[0] + start[1] * end[1]
    length = math.hypot(*start) * math.hypot(*end)
    if length == 0:
        return 0
    angle = math.acos(max(-1, min(1, dot / length)))
    if start[0] * end[1] - start[1] * end[0] < 0:
        angle = -angle
    return angle


def arc_points(
    current: tuple[float, float],
    rx: float,
    ry: float,
    rotation: float,
    large_arc: int,
    sweep: int,
    target: tuple[float, float],
) -> list[tuple[float, float]]:
    if rotation != 0:
        raise RuntimeError("The favicon SVG renderer only supports unrotated arcs")

    x1, y1 = current
    x2, y2 = target
    rx = abs(rx)
    ry = abs(ry)
    x1p = (x1 - x2) / 2
    y1p = (y1 - y2) / 2
    radii_check = x1p**2 / rx**2 + y1p**2 / ry**2
    if radii_check > 1:
        scale = math.sqrt(radii_check)
        rx *= scale
        ry *= scale

    numerator = rx**2 * ry**2 - rx**2 * y1p**2 - ry**2 * x1p**2
    denominator = rx**2 * y1p**2 + ry**2 * x1p**2
    coefficient = math.sqrt(max(0, numerator / denominator)) if denominator else 0
    if large_arc == sweep:
        coefficient *= -1
    cxp = coefficient * rx * y1p / ry
    cyp = coefficient * -ry * x1p / rx
    cx = cxp + (x1 + x2) / 2
    cy = cyp + (y1 + y2) / 2

    start_vector = ((x1p - cxp) / rx, (y1p - cyp) / ry)
    end_vector = ((-x1p - cxp) / rx, (-y1p - cyp) / ry)
    theta = vector_angle((1, 0), start_vector)
    delta = vector_angle(start_vector, end_vector)
    if not sweep and delta > 0:
        delta -= 2 * math.pi
    elif sweep and delta < 0:
        delta += 2 * math.pi

    steps = max(8, math.ceil(abs(delta) / (math.pi / 24)))
    return [
        (cx + rx * math.cos(theta + delta * i / steps), cy + ry * math.sin(theta + delta * i / steps))
        for i in range(1, steps + 1)
    ]


def path_subpaths(path_data: str) -> list[list[tuple[float, float]]]:
    tokens = tokenize_path(path_data)
    subpaths: list[list[tuple[float, float]]] = []
    current = (0.0, 0.0)
    start = (0.0, 0.0)
    active: list[tuple[float, float]] | None = None
    command = ""
    index = 0

    def number() -> float:
        nonlocal index
        value = float(tokens[index])
        index += 1
        return value

    while index < len(tokens):
        if re.match(r"[A-Za-z]", tokens[index]):
            command = tokens[index]
            index += 1

        if command == "M":
            current = (number(), number())
            start = current
            active = [current]
            subpaths.append(active)
        elif command == "H":
            current = (number(), current[1])
            active.append(current)
        elif command == "V":
            current = (current[0], number())
            active.append(current)
        elif command == "L":
            current = (number(), number())
            active.append(current)
        elif command == "C":
            p0 = current
            p1 = (number(), number())
            p2 = (number(), number())
            p3 = (number(), number())
            for step in range(1, 25):
                active.append(cubic_point(p0, p1, p2, p3, step / 24))
            current = p3
        elif command == "A":
            rx = number()
            ry = number()
            rotation = number()
            large_arc = int(number())
            sweep = int(number())
            target = (number(), number())
            active.extend(arc_points(current, rx, ry, rotation, large_arc, sweep, target))
            current = target
        elif command == "Z":
            active.append(start)
            current = start
        else:
            raise RuntimeError(f"Unsupported SVG path command in favicon.svg: {command}")

    return subpaths


def draw_round_line(
    draw: ImageDraw.ImageDraw,
    points: list[tuple[float, float]],
    fill: str,
    width: int,
) -> None:
    if len(points) < 2:
        return
    draw.line(points, fill=fill, width=width)
    radius = width / 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def draw_favicon_source_icon(image: Image.Image) -> None:
    root = ET.fromstring(FAVICON_PATH.read_text(encoding="utf-8"))
    namespace = "{http://www.w3.org/2000/svg}"
    scale = 4
    icon = Image.new("RGBA", (512 * scale, 512 * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)

    def scaled(value: float | str | None, default: float = 0) -> float:
        if value is None:
            return default * scale
        return float(value) * scale

    def scale_points(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
        return [(x * scale, y * scale) for x, y in points]

    for element in root.iter():
        tag = element.tag.removeprefix(namespace)
        if tag == "rect":
            x = scaled(element.get("x"))
            y = scaled(element.get("y"))
            width = scaled(element.get("width"))
            height = scaled(element.get("height"))
            rx = scaled(element.get("rx"))
            draw.rounded_rectangle((x, y, x + width, y + height), radius=rx, fill=element.get("fill"))
        elif tag == "path":
            stroke = element.get("stroke")
            fill = element.get("fill")
            subpaths = [scale_points(subpath) for subpath in path_subpaths(element.get("d", ""))]
            if stroke:
                width = round(float(element.get("stroke-width", "1")) * scale)
                for subpath in subpaths:
                    draw_round_line(draw, subpath, stroke, width)
            elif fill:
                for subpath in subpaths:
                    draw.polygon(subpath, fill=fill)
        elif tag == "circle":
            cx = scaled(element.get("cx"))
            cy = scaled(element.get("cy"))
            radius = scaled(element.get("r"))
            draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=element.get("fill"))

    icon = icon.resize((72, 72), Image.Resampling.LANCZOS)
    image.alpha_composite(icon, (564, 184))


def text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, spacing: float = 0) -> float:
    if not text:
        return 0
    return sum(draw.textlength(char, font=font) for char in text) + spacing * max(len(text) - 1, 0)


def draw_spaced_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[float, float],
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: str,
    spacing: float = 0,
    anchor: str = "ls",
) -> float:
    x, y = xy
    for index, char in enumerate(text):
        draw.text((x, y), char, font=font, fill=fill, anchor=anchor)
        x += draw.textlength(char, font=font)
        if index != len(text) - 1:
            x += spacing
    return x


def draw_center_wordmark(image: Image.Image, font_path: Path) -> None:
    draw = ImageDraw.Draw(image)
    bello_font = outfit(font_path, 68, 800)
    treno_font = outfit(font_path, 68, 500)
    spacing = -0.04 * 68
    bello = "Bello"
    treno = "Treno"
    bello_width = text_width(draw, bello, bello_font, spacing)
    treno_width = text_width(draw, treno, treno_font, spacing)
    total_width = bello_width + spacing + treno_width
    x = 600 - total_width / 2
    x = draw_spaced_text(draw, (x, 325), bello, bello_font, "#141b2b", spacing)
    x += spacing
    draw_spaced_text(draw, (x, 325), treno, treno_font, "#6a8a9f", spacing)


def draw_centered_text(draw: ImageDraw.ImageDraw, center_x: float, baseline_y: float, text: str, font: ImageFont.FreeTypeFont, fill: str) -> None:
    bbox = draw.textbbox((0, 0), text, font=font, anchor="ls")
    width = bbox[2] - bbox[0]
    draw.text((center_x - width / 2, baseline_y), text, font=font, fill=fill, anchor="ls")


def render() -> None:
    font_path = extract_outfit_font()
    image = radial_light((WIDTH, HEIGHT))
    image = add_linear_overlay(image, (143, 88, 108), 0.22, "warm")
    image = add_linear_overlay(image, (69, 138, 118), 0.20, "cool")
    draw_shadowed_card(image)
    draw_favicon_source_icon(image)

    draw = ImageDraw.Draw(image)
    draw_center_wordmark(image, font_path)
    draw_centered_text(draw, 600, 374, "Italian trains, stations, notices and statistics", outfit(font_path, 25, 800), "#445061")

    draw.rounded_rectangle((378, 397, 822, 453), radius=28, fill=hex_to_rgba("#edf4f8", 1), outline=hex_to_rgba("#ffffff", 0.86), width=2)
    draw_centered_text(draw, 600, 433, "Cerca treni italiani in tempo reale", outfit(font_path, 21, 800), "#556575")

    PNG_PATH.unlink(missing_ok=True)
    image.convert("RGB").save(PNG_PATH, "PNG", optimize=True)
    with PNG_PATH.open("rb") as png_file:
        header = png_file.read(24)
    if header[:8].hex() != "89504e470d0a1a0a":
        raise RuntimeError("Generated og-image.png is not a PNG file")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if (width, height) != (WIDTH, HEIGHT):
        raise RuntimeError(f"Generated og-image.png has {width}x{height}; expected {WIDTH}x{HEIGHT}")
    print(f"generated {PNG_PATH} ({width}x{height}, {PNG_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    render()
