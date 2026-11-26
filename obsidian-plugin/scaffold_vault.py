"""
scaffold_vault.py — Idempotently scaffolds a fresh Obsidian LifeOS (GTD + PARA) vault
and installs the built horizon-lifeos plugin into .obsidian/plugins/horizon-lifeos/.

Never overwrites existing user Markdown notes.
Usage: py obsidian-plugin/scaffold_vault.py --target "C:\\Obsidian\\LifeOS"
"""

from pathlib import Path
from datetime import date, timedelta
import argparse
import json
import shutil

PLUGIN_DIR = Path(__file__).resolve().parent
BUILT_PLUGIN_DIR = PLUGIN_DIR / "horizon-lifeos"


def write_if_missing(path: Path, content: str, created: list[str]) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    created.append(str(path))


def scaffold_vault(target_dir: Path, include_samples: bool = True) -> dict:
    if not BUILT_PLUGIN_DIR.joinpath("main.js").exists():
        raise RuntimeError("Built plugin missing. Run `py obsidian-plugin/build_plugin.py` first.")

    target_dir.mkdir(parents=True, exist_ok=True)
    created: list[str] = []
    today = date.today()
    today_str = today.isoformat()
    d2 = (today + timedelta(days=2)).isoformat()
    d11 = (today + timedelta(days=11)).isoformat()
    d34 = (today + timedelta(days=34)).isoformat()
    d_old = (today - timedelta(days=16)).isoformat()

    for rel in [
        "00_Inbox",
        "10_Projects",
        "20_Areas",
        "30_Resources",
        "40_Archives",
        "90_System/Templates",
        "90_System/Exports",
    ]:
        (target_dir / rel).mkdir(parents=True, exist_ok=True)

    for area in ["Work", "Personal", "Health", "Finance"]:
        lines = [
            "---",
            "type: area",
            f"area: {area}",
            "---",
            "",
            f"# {area}",
            "",
            "## Next Actions",
            "",
        ]
        if include_samples and area == "Work":
            lines.extend([
                f"- [ ] Legal sign-off on contract renewal 📅 {d11} ➕ {today_str} #waiting #sample ^hz-smp1",
                "\t- ◷ Ana (Legal)",
                f"- [ ] Clean up project bookmarks ➕ {d_old} #sample ^hz-smp2",
                "",
            ])
        elif include_samples and area == "Personal":
            lines.extend([
                f"- [ ] Renew car insurance #home 🔁 every year 📅 {d34} ➕ {today_str} #sample ^hz-smp3",
                "",
            ])
        write_if_missing(target_dir / "20_Areas" / f"{area}.md", "\n".join(lines), created)

    write_if_missing(target_dir / "00_Inbox" / "Quick Inbox.md", "# Quick Inbox\n\n", created)
    if include_samples:
        write_if_missing(
            target_dir / "00_Inbox" / f"Capture {today.strftime('%Y%m%d')}-Sample.md",
            "Order ergonomic mouse pad for work desk #sample\n",
            created,
        )

    if include_samples:
        write_if_missing(
            target_dir / "10_Projects" / "Finalize Q1 Vendor Proposal.md",
            "\n".join([
                "---",
                "type: project",
                "status: active",
                "today: true",
                'area: "[[Work]]"',
                f"due: {d2}",
                f"created: {today_str}",
                'snoozed_until: ""',
                'waiting_on: ""',
                'closed: ""',
                "sample: true",
                "---",
                "",
                "# Finalize Q1 Vendor Proposal",
                "",
                "## Steps",
                f"- [x] Collect vendor quotes ✅ {today_str}",
                f"- [/] Verify pricing table on slide 4 #next ➕ {today_str}",
                f"- [ ] Send draft for review ➕ {today_str}",
                "",
            ]),
            created,
        )

    write_if_missing(
        target_dir / "30_Resources" / "GTD + PARA Reference.md",
        "\n".join([
            "# GTD + PARA Reference",
            "",
            "- **00_Inbox/**: Raw voice captures & unprocessed items (process to zero weekly).",
            "- **10_Projects/**: Outcomes requiring 2+ steps with a finish line.",
            "- **20_Areas/**: Ongoing spheres (`Work`, `Personal`, `Health`, `Finance`) with single-step tasks.",
            "- **30_Resources/**: Reference notes without deadlines.",
            "- **40_Archives/**: Completed projects & append-only `Completed Tasks.md` log.",
            "",
        ]),
        created,
    )

    write_if_missing(
        target_dir / "40_Archives" / "Completed Tasks.md",
        "# Completed Tasks Archive\n\n",
        created,
    )

    write_if_missing(
        target_dir / "90_System" / "Templates" / "Project Template.md",
        "\n".join([
            "---",
            "type: project",
            "status: active",
            "today: false",
            'area: "[[Work]]"',
            "due: ",
            "created: {{date:YYYY-MM-DD}}",
            'snoozed_until: ""',
            'waiting_on: ""',
            'closed: ""',
            "---",
            "",
            "# {{title}}",
            "",
            "## Outcome & Notes",
            "",
            "## Steps",
            "- [ ] First physical next action #next ➕ {{date:YYYY-MM-DD}}",
            "",
        ]),
        created,
    )

    write_if_missing(
        target_dir / "90_System" / "GTD Dashboard.md",
        "\n".join([
            "# LifeOS GTD + PARA Desk",
            "",
            "Click the **Horizon** calendar icon in the left ribbon (or run `Open Horizon Desk`) for your visual deadline stripe, Today-3 cap, Morning Check-in, Weekly Review, and Inbox Triage.",
            "",
            "## Weekly Review Checklist",
            "1. Process `00_Inbox/` to zero.",
            "2. Check every active note in `10_Projects/` has a concrete next step.",
            "3. Follow up on `◷ Waiting on` items.",
            "4. Scan `Someday` and click **Archive done** to move completed work to `40_Archives/`.",
            "",
        ]),
        created,
    )

    write_if_missing(
        target_dir / "90_System" / "iPhone & Multi-PC Setup Guide.md",
        "\n".join([
            "# iPhone, Work PC & Remotely Save Setup",
            "",
            "## 1. Sync Rule (Windows + iPhone)",
            "- Keep this vault **outside** Windows OneDrive desktop sync (`C:\\Obsidian\\LifeOS`).",
            "- Install **Remotely Save** on Home PC, Work PC, and iPhone (OneDrive Personal, Auto Run every 5 min).",
            "- On a **secondary PC**, start with an empty vault, install Remotely Save, **pull first**, and only then install/enable Horizon LifeOS (do NOT run `Initialize PARA + GTD Vault` before your first pull).",
            "",
            "## 2. Getting Horizon LifeOS onto iPhone",
            "- **Option A:** Enable **Sync Config Dir** in Remotely Save settings on all devices so `.obsidian/plugins/horizon-lifeos/` syncs automatically.",
            "- **Option B:** Install **BRAT** on iPhone and add the `mikepaez/horizon-tasks` GitHub release.",
            "",
            "## 3. Conflict-Free iPhone Voice Capture Shortcut",
            "In Apple Shortcuts:",
            "1. **Dictate Text**",
            "2. **URL Encode** `[Dictated Text]`",
            "3. **Format Date** (`yyyyMMdd-HHmmss`)",
            "4. **Open URL**:",
            "   `obsidian://new?vault=LifeOS&file=00_Inbox/Capture%20[Formatted%20Date]&content=[URL%20Encoded%20Text]&silent=true`",
            "",
            "> Using one capture file per voice note guarantees zero OneDrive/Remotely Save conflicts with desktop Inbox triage.",
            "",
        ]),
        created,
    )

    # Install built plugin into .obsidian/plugins/horizon-lifeos/
    plugin_dest = target_dir / ".obsidian" / "plugins" / "horizon-lifeos"
    plugin_dest.mkdir(parents=True, exist_ok=True)
    for fname in ("manifest.json", "main.js", "styles.css"):
        shutil.copyfile(BUILT_PLUGIN_DIR / fname, plugin_dest / fname)

    # Enable community plugin in .obsidian/community-plugins.json (merge cleanly if exists)
    cp_path = target_dir / ".obsidian" / "community-plugins.json"
    plugins_list = []
    if cp_path.exists():
        try:
            loaded = json.loads(cp_path.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                plugins_list = loaded
        except Exception:
            plugins_list = []
    if "horizon-lifeos" not in plugins_list:
        plugins_list.append("horizon-lifeos")
    cp_path.write_text(json.dumps(plugins_list, indent=2) + "\n", encoding="utf-8")

    return {"target": str(target_dir), "createdFilesCount": len(created), "pluginInstalledAt": str(plugin_dest)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scaffold LifeOS PARA+GTD Obsidian vault")
    parser.add_argument("--target", default=r"C:\Obsidian\LifeOS", help="Target vault path")
    parser.add_argument("--no-samples", action="store_true", help="Skip sample items")
    args = parser.parse_args()
    res = scaffold_vault(Path(args.target), include_samples=not args.no_samples)
    print(json.dumps(res, indent=2))
