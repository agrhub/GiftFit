#!/usr/bin/env python3
"""Repo-level entry point for the vendored YouCam skill CLI (.agents/skills/*/scripts/youcam_core.py).

- Reads YOUCAM_API_KEY from the environment, else from .env.local at the repo root (never printed).
- Re-executes itself with the repo .venv interpreter when requests/PyYAML are missing.
- Picks the skill whose api-fallback.yaml defines --feature, so `run`/`status`/`templates` work for any
  feature shipped by the six installed skills. Free commands: validate-key, credits, cost.

Usage (from the repo root):
    py scripts/youcam_core.py validate-key
    py scripts/youcam_core.py credits
    py scripts/youcam_core.py cost [--feature skin-analysis]
"""

import importlib.util
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS_DIR = os.path.join(REPO_ROOT, ".agents", "skills")
DEFAULT_SKILL = "skin-analysis-expert"
VENV_PYTHON = os.path.join(
    REPO_ROOT, ".venv", "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"
)


def _load_env_local() -> None:
    if os.environ.get("YOUCAM_API_KEY"):
        return
    path = os.path.join(REPO_ROOT, ".env.local")
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == "YOUCAM_API_KEY" and v.strip():
                os.environ["YOUCAM_API_KEY"] = v.strip().strip('"').strip("'")


def _ensure_deps() -> None:
    if all(importlib.util.find_spec(m) for m in ("requests", "yaml")):
        return
    if os.path.isfile(VENV_PYTHON) and os.path.abspath(sys.executable) != os.path.abspath(VENV_PYTHON):
        sys.exit(subprocess.call([VENV_PYTHON, os.path.abspath(__file__), *sys.argv[1:]]))
    sys.exit(
        "Missing requests/PyYAML. Run: py -m venv .venv && "
        ".venv/Scripts/python -m pip install -r .agents/skills/skin-analysis-expert/scripts/requirements.txt"
    )


def _skill_for(argv: list[str]) -> str:
    feature = None
    for i, a in enumerate(argv):
        if a == "--feature" and i + 1 < len(argv):
            feature = argv[i + 1]
        elif a.startswith("--feature="):
            feature = a.split("=", 1)[1]
    if feature and argv and argv[0] in ("run", "status", "templates"):
        needle = f"\n  {feature}:\n"
        for name in sorted(os.listdir(SKILLS_DIR)):
            yaml_path = os.path.join(SKILLS_DIR, name, "scripts", "api-fallback.yaml")
            if os.path.isfile(yaml_path):
                with open(yaml_path, encoding="utf-8") as fh:
                    if needle in fh.read():
                        return name
    return DEFAULT_SKILL


def main() -> None:
    _load_env_local()
    _ensure_deps()
    scripts_dir = os.path.join(SKILLS_DIR, _skill_for(sys.argv[1:]), "scripts")
    sys.path.insert(0, scripts_dir)
    import youcam_core  # noqa: E402  (vendored skill CLI)

    youcam_core.main()


if __name__ == "__main__":
    main()
