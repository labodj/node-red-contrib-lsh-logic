#!/usr/bin/env python3
"""Update node-red generated protocol files from the standalone lsh-protocol repo."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
TARGET_NAME = "node-red"
TARGET_ROOT_FLAG = "--node-red-root"


def candidate_protocol_roots() -> list[Path]:
    candidates: list[Path] = []
    env_root = os.environ.get("LSH_PROTOCOL_ROOT")
    if env_root:
        candidates.append(Path(env_root).expanduser().resolve())

    candidates.append((REPO_ROOT / "vendor" / "lsh-protocol").resolve())
    candidates.append((REPO_ROOT.parent / "lsh-protocol").resolve())
    return candidates


def resolve_protocol_root(cli_root: Path | None) -> Path:
    if cli_root is not None:
        root = cli_root.expanduser().resolve()
        if not (root / "tools" / "generate_lsh_protocol.py").is_file():
            raise SystemExit(f"Invalid --protocol-root: generator not found in {root}")
        return root

    for root in candidate_protocol_roots():
        if (root / "tools" / "generate_lsh_protocol.py").is_file():
            return root

    raise SystemExit(
        "Unable to locate lsh-protocol. Use --protocol-root, set LSH_PROTOCOL_ROOT, "
        "or vendor the repo at vendor/lsh-protocol.",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated files are stale")
    parser.add_argument("--protocol-root", type=Path, help="path to the lsh-protocol repository")
    args = parser.parse_args()

    protocol_root = resolve_protocol_root(args.protocol_root)
    generator = protocol_root / "tools" / "generate_lsh_protocol.py"

    command = [
        sys.executable,
        str(generator),
        "--target",
        TARGET_NAME,
        TARGET_ROOT_FLAG,
        str(REPO_ROOT),
    ]
    if args.check:
        command.append("--check")

    completed = subprocess.run(command, check=False)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
