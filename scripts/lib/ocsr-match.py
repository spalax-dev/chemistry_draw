#!/usr/bin/env python3
"""RDKit comparator for the Phase D hand-drawn OCSR parity run.

Reads JSONL pairs ``{"id", "expected", "got"}`` and writes one JSONL row per
pair with the fields consumed by ``scripts/lib/model-parity.mjs``:

    {"id", "exact", "canonical", "valid", "incomparable",
     "canonical_expected", "canonical_got"}

Rules (docs/benchmarks/model-parity.md §3.3 and docs/testing.md §6.4):

- ``exact`` is raw string equality over all rows; a missing answer is a failure.
- ``valid`` mirrors the toolchain heuristic: an answer exists (a 422/incomplete
  row has no SMILES and is invalid). It is not an RDKit parse check.
- ``canonical`` compares isomeric RDKit canonical SMILES and is only defined
  when both strings parse; otherwise ``canonical`` is null and
  ``incomparable`` is true. The canonical rate divides by comparable pairs.

Usage::

    $TOOLCHAIN/.venv/bin/python scripts/lib/ocsr-match.py pairs.jsonl out.jsonl
"""

import json
import sys

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")


def canonical(smiles):
    """Return isomeric canonical SMILES, or None when RDKit cannot parse it."""
    if not isinstance(smiles, str) or smiles.strip() == "":
        return None
    molecule = Chem.MolFromSmiles(smiles)
    if molecule is None:
        return None
    return Chem.MolToSmiles(molecule)


def compare(pair):
    pair_id = pair["id"]
    expected = pair["expected"]
    got = pair.get("got")

    valid = isinstance(got, str) and got.strip() != ""
    exact = valid and got == expected
    canonical_expected = canonical(expected)
    canonical_got = canonical(got) if valid else None

    if canonical_expected is None or canonical_got is None:
        incomparable = True
        canonical_match = None
    else:
        incomparable = False
        canonical_match = canonical_expected == canonical_got

    return {
        "id": pair_id,
        "exact": exact,
        "canonical": canonical_match,
        "valid": valid,
        "incomparable": incomparable,
        "canonical_expected": canonical_expected,
        "canonical_got": canonical_got,
    }


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: ocsr-match.py <pairs.jsonl> <out.jsonl>")

    pairs_path, out_path = argv[1], argv[2]
    rows = []
    with open(pairs_path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(compare(json.loads(line)))

    with open(out_path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(json.dumps({"rows": len(rows)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
