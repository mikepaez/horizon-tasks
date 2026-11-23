"""
build_portable.py — Bundles Horizon into ONE single self-contained HTML file.

Run with: py build_portable.py
Output:   horizon-portable.html (copy this one file to any laptop — no Python needed!)
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_FILE = BASE_DIR / "horizon-portable.html"


def build_portable(base_dir: Path = BASE_DIR, output_file: Path = OUTPUT_FILE) -> Path:
    html = (base_dir / "index.html").read_text(encoding="utf-8")
    css = (base_dir / "styles.css").read_text(encoding="utf-8")
    logic_js = (base_dir / "logic.js").read_text(encoding="utf-8")
    app_js = (base_dir / "app.js").read_text(encoding="utf-8")

    # Replace external CSS link and external script tags with inline blocks
    css_tag = '<link rel="stylesheet" href="styles.css" />'
    logic_tag = '<script src="logic.js"></script>'
    app_tag = '<script src="app.js"></script>'

    if css_tag not in html or logic_tag not in html or app_tag not in html:
        raise RuntimeError("index.html is missing one of the expected styles/script tags.")

    bundled = (
        html.replace(css_tag, f"<style>\n{css}\n  </style>", 1)
        .replace(logic_tag, f"<script>\n{logic_js}\n  </script>", 1)
        .replace(app_tag, f"<script>\n{app_js}\n  </script>", 1)
    )

    output_file.write_text(bundled, encoding="utf-8")
    return output_file


if __name__ == "__main__":
    out = build_portable()
    size_kb = out.stat().st_size / 1024
    print(f"Built {out.name} ({size_kb:.2f} KB) -> {out}")
