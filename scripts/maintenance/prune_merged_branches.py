#!/usr/bin/env python3
"""Prune only exact-SHA, merged-PR Workspace branches from an audited manifest.

Dry-run is the default; --apply additionally requires main-branch GitHub
Actions context. This is intentionally not a general branch deletion utility.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

REPOSITORY = "sjevans1/Workspace-Platform"
MANIFEST = "maintenance/merged-branch-prune-2026-10-01.json"
PROTECTED = {
    "main",
    "feature/w08-visible-page-regression-prep",
    "feature/oidc-tenant-state-provenance",
}
VALID_BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\Z")
VALID_SHA = re.compile(r"[0-9a-f]{40}\Z")


def load_manifest(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("repository") != REPOSITORY:
        raise ValueError("Manifest repository must be the standalone Workspace repo")
    if not PROTECTED.issubset(set(data.get("protected_branches", []))):
        raise ValueError("Manifest must explicitly protect all retained branches")
    records = data.get("candidates", [])
    if not isinstance(records, list) or len(records) != 25:
        raise ValueError("Expected exactly 25 previously audited PR branches")
    seen = set()
    for rec in records:
        branch = rec.get("branch", "")
        number = rec.get("merged_pr")
        sha = rec.get("expected_sha", "")
        if (not isinstance(branch, str) or not VALID_BRANCH.fullmatch(branch)
                or ".." in branch or "//" in branch or branch.endswith("/")
                or branch in PROTECTED or branch in seen
                or not isinstance(number, int) or number <= 0
                or not isinstance(sha, str) or not VALID_SHA.fullmatch(sha)):
            raise ValueError("Invalid/duplicate/protected branch in cleanup manifest")
        seen.add(branch)
    return records


def github_api(path: str, method: str = "GET"):
    token = os.environ.get("GH_TOKEN", "")
    if not token:
        raise RuntimeError("GH_TOKEN must be supplied by the audited Actions job")
    base = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    req = Request(
        base + "/" + path.lstrip("/"),
        method=method,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "workspace-audited-branch-prune",
        },
    )
    try:
        with urlopen(req, timeout=25) as response:
            data = response.read()
            return json.loads(data) if data else {}
    except HTTPError as exc:
        if exc.code == 404 and method == "GET" and "/git/ref/" in path:
            return None
        raise RuntimeError(
            "GitHub API returned HTTP " + str(exc.code)
            + " for " + method + " (credential contents suppressed)"
        ) from exc


def cleanup(candidates: list[dict]) -> tuple[int, int]:
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise RuntimeError("Repository guard failed")
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("Pruning requires a trusted main-branch Actions run")
    prefix = "repos/" + REPOSITORY
    open_prs = github_api(prefix + "/pulls?state=open&per_page=100")
    if not isinstance(open_prs, list) or len(open_prs) >= 100:
        raise RuntimeError("Open PR inventory incomplete; abort before deleting")
    protected_heads = {
        p.get("head", {}).get("ref")
        for p in open_prs
        if p.get("head", {}).get("repo", {}).get("full_name") == REPOSITORY
    }
    deleted = skipped = 0
    for rec in candidates:
        branch = rec["branch"]
        if branch in protected_heads:
            print("SKIP open-PR head:", branch, flush=True)
            skipped += 1
            continue
        branch_api = prefix + "/git/ref/" + quote("heads/" + branch, safe="/")
        ref = github_api(branch_api)
        if ref is None:
            print("SKIP already absent:", branch, flush=True)
            skipped += 1
            continue
        if ref.get("object", {}).get("sha") != rec["expected_sha"]:
            print("SKIP branch advanced since audit:", branch, flush=True)
            skipped += 1
            continue
        pr = github_api(prefix + "/pulls/" + str(rec["merged_pr"]))
        head = pr.get("head", {})
        if (pr.get("state") != "closed" or not pr.get("merged_at")
                or pr.get("base", {}).get("ref") != "main"
                or head.get("ref") != branch
                or head.get("repo", {}).get("full_name") != REPOSITORY
                or head.get("sha") != rec["expected_sha"]):
            print("SKIP PR merge or SHA verification failed:", branch, flush=True)
            skipped += 1
            continue
        github_api(prefix + "/git/refs/" + quote("heads/" + branch, safe="/"),
                   method="DELETE")
        if github_api(branch_api) is not None:
            raise RuntimeError("Branch remained after deletion: " + branch)
        print("DELETED audited merged branch:", branch, flush=True)
        deleted += 1
    return deleted, skipped


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path(MANIFEST))
    parser.add_argument("--apply", action="store_true",
                        help="DELETE audited refs, main Actions context only")
    args = parser.parse_args()
    records = load_manifest(args.manifest)
    if not args.apply:
        print("DRY RUN ONLY: validated", len(records), "merged-PR candidates.")
        print("Protected: " + ", ".join(sorted(PROTECTED)))
        return 0
    deleted, skipped = cleanup(records)
    print(f"SUMMARY: deleted={deleted}, skipped={skipped}, candidates={len(records)}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("SAFE STOP:", str(exc), file=sys.stderr)
        sys.exit(1)
