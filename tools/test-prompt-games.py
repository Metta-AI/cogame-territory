"""Play complete Territory games through the production text bridge across wordings."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

WORDINGS = ("canonical", "plain", "numbered", "questions", "reordered", "heldout-briefing", "heldout-reference")


def play(binary: Path, variant: str, wording: str, prompt_seed: int, seed: int) -> str:
    process = subprocess.Popen(["node", str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    assert process.stdin is not None and process.stdout is not None
    digest = hashlib.sha256()

    def request(payload: dict) -> dict:
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()
        return json.loads(process.stdout.readline())

    def record(value: dict) -> None:
        digest.update(json.dumps(value, sort_keys=True).encode())

    try:
        observation = request(
            {
                "kind": "reset",
                "seed": str(seed),
                "players": 9,
                "variant": variant,
                "promptVariant": wording,
                "promptSeed": prompt_seed,
                "split": "validation",
            }
        )
        decisions = 0
        system_seen = None
        boards = {}
        while observation["kind"] == "decision":
            view = observation["semantic_view"]
            system, user = [m["content"] for m in observation["messages"]]
            assert view.pop("prompt_template") == {
                "bank": "territory-rules-v1",
                "selection": wording,
                "variant": WORDINGS[prompt_seed % 5] if wording == "mixed" else wording,
                "seed": prompt_seed,
                "system_sha256": hashlib.sha256(system.encode()).hexdigest(),
                "user_sha256": hashlib.sha256(user.encode()).hexdigest(),
            }
            if system_seen is None:
                system_seen = system
            assert system == system_seen
            assert all("paint" not in cog for cog in view["cogs"])
            if view["turn"] in boards:
                assert boards[view["turn"]] == view["tiles"]
            else:
                boards[view["turn"]] = view["tiles"]
            observation["messages"][0]["content"] = system.partition("\n")[2]
            record(observation)
            proposal = json.loads(request({"kind": "teacher"})["response"])
            result = request(
                {"kind": "step", "decision_id": observation["decision_id"], "response": json.dumps(proposal)}
            )
            assert result["kind"] == "accepted"
            record(result["action"])
            observation = result["observation"]
            decisions += 1
            assert decisions <= 162
        assert observation["kind"] == "terminal" and decisions == 162
        assert set(observation["scores"]) == {str(i) for i in range(9)}
        record(observation)
        return digest.hexdigest()
    finally:
        process.stdin.close()
        process.stdout.close()
        assert process.wait(timeout=10) == 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    for variant in ("open", "rooms", "inside_out"):
        for seed in (17, 946001):
            reference = play(args.binary, variant, "canonical", 0, seed)
            for wording, prompt_seed in [(w, 0) for w in WORDINGS[1:]] + [("mixed", i) for i in range(5)]:
                assert play(args.binary, variant, wording, prompt_seed, seed) == reference
        print(variant, "24 complete games PASS", flush=True)
    for wording in WORDINGS[-2:]:
        rejected = subprocess.run(
            ["node", str(args.binary)],
            input=json.dumps({"kind": "reset", "seed": "7", "players": 9, "promptVariant": wording}) + "\n",
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert rejected.returncode != 0 and "held-out wording cannot enter training" in rejected.stderr
    print("72 complete games and held-out exclusion PASS", flush=True)


if __name__ == "__main__":
    main()
