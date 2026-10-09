#!/usr/bin/env python3
"""Canonical CLI entry point for DSH + plugins Dataset selection."""

try:
    from .dataset_selection_cli import main
except ImportError:  # direct execution: python planning/dataset_select_cli.py
    from dataset_selection_cli import main


if __name__ == "__main__":
    raise SystemExit(main())
