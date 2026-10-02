"""Offline safety tests for one-time Workspace merged-branch pruning."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import prune_merged_branches as clean

BRANCH = "feature/example-merged"
SHA = "a" * 40
RECORD = {"branch": BRANCH, "merged_pr": 99, "expected_sha": SHA}


def matching_pr(merged=True):
    return {
        "state": "closed", "merged_at": "2026-10-01T12:00:00Z" if merged else None,
        "head": {"ref": BRANCH, "sha": SHA,
                 "repo": {"full_name": clean.REPOSITORY}},
        "base": {"ref": "main"},
    }


class BranchCleanupTests(unittest.TestCase):
    def fake_api(self, *, actual_sha=SHA, merged=True, open_branch=False):
        events = []
        state = {"exists": True}
        def call(path, method="GET"):
            events.append((method, path))
            if path.endswith("pulls?state=open&per_page=100"):
                return [{"head": {"ref": BRANCH, "repo": {
                    "full_name": clean.REPOSITORY}}}] if open_branch else []
            if path.endswith("/pulls/99"):
                return matching_pr(merged=merged)
            if "/git/ref/" in path and method == "GET":
                return {"object": {"sha": actual_sha}} if state["exists"] else None
            if "/git/refs/" in path and method == "DELETE":
                state["exists"] = False
                return {}
            raise AssertionError("Unexpected API call: " + path)
        return call, events

    def perform(self, stub):
        with patch.dict(os.environ, {
            "GITHUB_REPOSITORY": clean.REPOSITORY,
            "GITHUB_REF": "refs/heads/main",
        }), patch.object(clean, "github_api", side_effect=stub):
            return clean.cleanup([RECORD])

    def test_deletes_only_exact_sha_closed_merged_pr(self):
        fake, log = self.fake_api()
        self.assertEqual(self.perform(fake), (1, 0))
        self.assertEqual(sum(method == "DELETE" for method, _ in log), 1)

    def test_skips_changed_head(self):
        fake, log = self.fake_api(actual_sha="b" * 40)
        self.assertEqual(self.perform(fake), (0, 1))
        self.assertFalse(any(method == "DELETE" for method, _ in log))

    def test_skips_closed_unmerged_pr(self):
        fake, log = self.fake_api(merged=False)
        self.assertEqual(self.perform(fake), (0, 1))
        self.assertFalse(any(method == "DELETE" for method, _ in log))

    def test_skips_branch_with_open_pr(self):
        fake, log = self.fake_api(open_branch=True)
        self.assertEqual(self.perform(fake), (0, 1))
        self.assertFalse(any(method == "DELETE" for method, _ in log))

    def test_requires_main_branch(self):
        fake, log = self.fake_api()
        with patch.dict(os.environ, {
            "GITHUB_REPOSITORY": clean.REPOSITORY,
            "GITHUB_REF": "refs/heads/feature/w08-visible-page-regression-prep",
        }), patch.object(clean, "github_api", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "main-branch"):
                clean.cleanup([RECORD])
        self.assertEqual(log, [])

    def test_manifest_protects_unmerged_and_active_branches(self):
        manifest = Path(__file__).resolve().parents[2] / clean.MANIFEST
        records = clean.load_manifest(manifest)
        self.assertEqual(len(records), 25)
        self.assertNotIn("feature/oidc-tenant-state-provenance",
                         [r["branch"] for r in records])
        self.assertNotIn("feature/w08-visible-page-regression-prep",
                         [r["branch"] for r in records])
        self.assertTrue(all(r["branch"] not in clean.PROTECTED for r in records))


if __name__ == "__main__":
    unittest.main()
