"""Exercise complete Territory games through the numeric bridge."""

import json
import random
import subprocess
import sys
from pathlib import Path


manifest = Path(__file__).resolve().parents[1] / "coworld_manifest_template.json"
for variant in ("open", "rooms", "inside_out"):
    for policy in ("teacher", "random"):
        with subprocess.Popen(
            ["node", sys.argv[1], str(manifest), variant],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        ) as bridge:
            assert bridge.stdin is not None and bridge.stdout is not None

            def request(payload):
                bridge.stdin.write(json.dumps(payload) + "\n")
                bridge.stdin.flush()
                return json.loads(bridge.stdout.readline())

            observation = request({"kind": "reset", "seed": f"{variant}-{policy}", "players": 9})
            rng = random.Random(42)
            decisions = 0
            while observation["kind"] == "decision":
                view = observation["semantic_view"]
                assert view["you"]["seat"] == observation["seat"]
                assert "paint" not in view["cogs"][0]
                assert observation["messages"][1]["content"].startswith("TURN ")
                encoded = request({"kind": "encode"})
                assert encoded["decision_id"] == observation["decision_id"]
                assert len(encoded["values"]) == 908
                assert len(encoded["actions"]) == 373
                legal = [action for action in encoded["actions"] if action is not None]
                if policy == "teacher":
                    action = json.loads(request({"kind": "teacher"})["response"])
                else:
                    action = rng.choice(legal)
                assert action in legal
                result = request(
                    {"kind": "step", "decision_id": observation["decision_id"], "response": json.dumps(action)}
                )
                assert result["kind"] == "accepted" and result["action"] == action
                observation = result["observation"]
                decisions += 1
            assert 1 <= decisions <= 18 * 9
            assert set(observation["scores"]) == {str(seat) for seat in range(9)}
            assert all(score >= 0 for score in observation["scores"].values())
            bridge.stdin.close()
            assert bridge.wait() == 0
        print(f"{variant} {policy}: {decisions} decisions, 908 values")
