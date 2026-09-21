"""Resolve APEX_HOME for standalone skill scripts.

Skill scripts may run outside the agent process (system Python, nix env,
CI) where ``apex_constants`` is not importable.  This module provides the
same ``get_apex_home()`` contract without requiring it on ``sys.path``.

When ``apex_constants`` IS available it is used directly so profile
resolution and any future enhancements are picked up automatically.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from apex_constants import get_apex_home as get_apex_home
except (ModuleNotFoundError, ImportError):

    def get_apex_home() -> Path:
        """Return the Apex home directory (default: ``~/.apex-agent``)."""
        val = os.environ.get("APEX_HOME", "").strip()
        return Path(val) if val else Path.home() / ".apex-agent"
