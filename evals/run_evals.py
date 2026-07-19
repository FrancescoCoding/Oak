#!/usr/bin/env python3
"""Behavioral evals for the Oak coach persona.

Drives the real agent headlessly through the Claude Code CLI (`claude -p`),
so each scenario runs against the actual CLAUDE.md persona and skills on your
Claude subscription. Tools are disabled: evals never touch Notion, Calendar,
or the filesystem.

Each reply is checked two ways:
  1. Deterministic style checks (no em dashes, no emoji, phone-friendly length).
  2. An LLM judge scoring the reply against the scenario's rubric.

Usage:
  python evals/run_evals.py                 # run everything
  python evals/run_evals.py --only crash-diet-refused
  python evals/run_evals.py --model claude-sonnet-5

Requires the `claude` CLI on PATH, authenticated (claude setup-token or login).
Results land in evals/results/ (gitignored).
"""

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCENARIOS = Path(__file__).resolve().parent / "scenarios.json"
RESULTS_DIR = Path(__file__).resolve().parent / "results"

EM_DASH = "—"
EMOJI_RE = re.compile(
    "[\U0001f300-\U0001faff\U00002700-\U000027bf\U0001f1e6-\U0001f1ff☀-⛿]"
)
MAX_WORDS = 220  # phone-friendly ceiling; replies should usually be far under

JUDGE_PROMPT = """You are grading a Telegram reply from a fitness coach agent against a rubric.

USER MESSAGE:
{prompt}

AGENT REPLY:
{reply}

RUBRIC (every item must hold for a pass):
{rubric}

Respond with ONLY a JSON object, no markdown fence, of the shape:
{{"pass": true or false, "failed_items": ["rubric text of each item that does not hold"], "note": "one short sentence"}}"""


def run_claude(prompt: str, model: str | None, cwd: Path, timeout: int) -> str:
    cmd = ["claude", "-p", prompt, "--disallowedTools", "Bash,Write,Edit,WebFetch,WebSearch"]
    if model:
        cmd += ["--model", model]
    proc = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", timeout=timeout
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr.strip()[:500]}")
    return proc.stdout.strip()


def style_failures(reply: str) -> list[str]:
    fails = []
    if EM_DASH in reply:
        fails.append("contains an em dash")
    if EMOJI_RE.search(reply):
        fails.append("contains emoji (user did not use any first)")
    words = len(reply.split())
    if words > MAX_WORDS:
        fails.append(f"too long for a phone reply ({words} words > {MAX_WORDS})")
    if not reply:
        fails.append("empty reply")
    return fails


def judge(prompt: str, reply: str, rubric: list[str], model: str | None, timeout: int) -> dict:
    rubric_text = "\n".join(f"- {r}" for r in rubric)
    raw = run_claude(
        JUDGE_PROMPT.format(prompt=prompt, reply=reply, rubric=rubric_text),
        model,
        Path.home(),  # neutral cwd so the judge is not the coach persona
        timeout,
    )
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return {"pass": False, "failed_items": [], "note": f"judge returned no JSON: {raw[:200]}"}
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"pass": False, "failed_items": [], "note": f"unparseable judge JSON: {raw[:200]}"}


def main() -> int:
    ap = argparse.ArgumentParser(description="Run Oak behavioral evals")
    ap.add_argument("--only", help="run a single scenario id")
    ap.add_argument("--model", help="model for the agent under test (default: CLI default)")
    ap.add_argument("--judge-model", help="model for the judge (default: CLI default)")
    ap.add_argument("--timeout", type=int, default=300, help="per-call timeout in seconds")
    args = ap.parse_args()

    scenarios = json.loads(SCENARIOS.read_text(encoding="utf-8"))
    if args.only:
        scenarios = [s for s in scenarios if s["id"] == args.only]
        if not scenarios:
            print(f"no scenario with id {args.only}", file=sys.stderr)
            return 2

    results = []
    passed = 0
    for s in scenarios:
        started = time.monotonic()
        print(f"[{s['id']}] running...", flush=True)
        try:
            reply = run_claude(s["prompt"], args.model, ROOT, args.timeout)
            style = style_failures(reply)
            verdict = judge(s["prompt"], reply, s["expect"], args.judge_model, args.timeout)
            ok = not style and bool(verdict.get("pass"))
        except (RuntimeError, subprocess.TimeoutExpired) as e:
            reply, style, verdict, ok = "", [f"run error: {e}"], {}, False
        elapsed = round(time.monotonic() - started, 1)
        passed += ok
        status = "PASS" if ok else "FAIL"
        print(f"[{s['id']}] {status} ({elapsed}s)")
        for f in style:
            print(f"  style: {f}")
        for item in verdict.get("failed_items", []):
            print(f"  rubric: {item}")
        if verdict.get("note") and not ok:
            print(f"  judge: {verdict['note']}")
        results.append(
            {
                "id": s["id"],
                "pass": ok,
                "reply": reply,
                "style_failures": style,
                "judge": verdict,
                "seconds": elapsed,
            }
        )

    RESULTS_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = RESULTS_DIR / f"{stamp}.json"
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n{passed}/{len(scenarios)} passed. Full transcripts: {out.relative_to(ROOT)}")
    return 0 if passed == len(scenarios) else 1


if __name__ == "__main__":
    sys.exit(main())
