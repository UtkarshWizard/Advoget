#!/usr/bin/env python3
"""Wrapper to run ai-service/scripts/pick_models.py from repository root."""
import runpy
import sys
from pathlib import Path

target = Path(__file__).resolve().parent.parent / "ai-service" / "scripts" / "pick_models.py"
sys.path.insert(0, str(target.parent))
runpy.run_path(str(target), run_name="__main__")

