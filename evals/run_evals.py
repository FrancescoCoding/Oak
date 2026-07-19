#!/usr/bin/env python3
"""Behavioral evals for the Oak coach persona.

Drives the real agent headlessly through the Claude Code CLI (`claude -p`),
so each scenario runs against the actual CLAUDE.md persona and skills on your
Claude subscription. The agent under test can run the bundled Notion helper
(scripts/notion.mjs and scripts/setup-workspace.mjs), so history checks and
logging hit the real workspace; note that log scenarios write real rows.
Everything else (Write, Edit, web access) stays disabled, and the judge runs
with no tools at all.

Each reply is checked two ways:
  1. Deterministic style checks (no em dashes, no emoji, non-empty reply).
     Conciseness is judged by the LLM rubric, not a hard word count.
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
import os
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

# The agent under test gets real access to the Notion helper so history checks,
# logging, and recommendations run against the actual workspace (log-workout
# scenarios do write real rows). Everything else stays locked down.
AGENT_ALLOWED_TOOLS = "Bash(node scripts/notion.mjs *),Bash(node scripts/setup-workspace.mjs *)"

JUDGE_PROMPT = """You are grading a Telegram reply from a fitness coach agent against a rubric.

Context: the agent has live access to the user's real Notion workout log and their
PERSONAL.md profile. Specific dates, sessions, loads, or profile details it cites are
real data it read, not fabrication. Fabrication means stating history or numbers it
could not have read (e.g. presenting a guess as a logged fact).

USER MESSAGE:
{prompt}

AGENT REPLY:
{reply}

RUBRIC (every item must hold for a pass):
{rubric}

Respond with ONLY a JSON object, no markdown fence, of the shape:
{{"pass": true or false, "failed_items": ["rubric text of each item that does not hold"], "note": "one short sentence"}}"""


DOTENV_KEYS = ("NOTION_TOKEN", "NOTION_PARENT_PAGE_ID")


def env_with_dotenv() -> dict:
    """os.environ plus the Notion vars from the repo's .env, so the spawned agent's
    Notion helper has its token. Only Notion keys are taken: other .env entries
    (e.g. CLAUDE_CODE_OAUTH_TOKEN, the deployed bot's credential) would break the
    local CLI's own authentication."""
    env = dict(os.environ)
    dotenv = ROOT / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() in DOTENV_KEYS:
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def run_claude(
    prompt: str, model: str | None, cwd: Path, timeout: int, allow_notion: bool = False
) -> str:
    disallowed = "Write,Edit,WebFetch,WebSearch" if allow_notion else "Bash,Write,Edit,WebFetch,WebSearch"
    cmd = ["claude", "-p", prompt, "--disallowedTools", disallowed]
    if allow_notion:
        cmd += ["--allowedTools", AGENT_ALLOWED_TOOLS]
    if model:
        cmd += ["--model", model]
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        env=env_with_dotenv(),
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
            reply = run_claude(s["prompt"], args.model, ROOT, args.timeout, allow_notion=True)
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
                "prompt": s["prompt"],
                "rubric": s["expect"],
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
    report = RESULTS_DIR / f"{stamp}.md"
    report.write_text(render_report(results, passed, stamp), encoding="utf-8")

    width = max(len(r["id"]) for r in results)
    print("\n" + "-" * (width + 18))
    for r in results:
        print(f"  {'PASS' if r['pass'] else 'FAIL'}  {r['id']:<{width}}  {r['seconds']}s")
    print("-" * (width + 18))
    print(f"{passed}/{len(scenarios)} passed. Report: {report.relative_to(ROOT)}")
    return 0 if passed == len(scenarios) else 1


def render_report(results: list[dict], passed: int, stamp: str) -> str:
    lines = [
        "# Oak eval report",
        "",
        f"Run: {stamp} UTC  |  Result: **{passed}/{len(results)} passed**",
        "",
        "| Scenario | Result | Time |",
        "|---|---|---|",
    ]
    for r in results:
        lines.append(f"| {r['id']} | {'✅ pass' if r['pass'] else '❌ fail'} | {r['seconds']}s |")
    lines.append("")
    for r in results:
        lines += [f"## {r['id']}", ""]
        if r.get("prompt"):
            lines += ["**Prompt:**", "", "> " + r["prompt"].replace("\n", "\n> "), ""]
        if r.get("rubric"):
            lines += ["**Rubric (each item must hold):**"] + [f"- {i}" for i in r["rubric"]] + [""]
        if r["style_failures"]:
            lines += ["**Style failures:**"] + [f"- {f}" for f in r["style_failures"]] + [""]
        failed_items = r.get("judge", {}).get("failed_items") or []
        if failed_items:
            lines += ["**Rubric items not met:**"] + [f"- {i}" for i in failed_items] + [""]
        note = r.get("judge", {}).get("note")
        if note:
            lines += [f"**Judge:** {note}", ""]
        lines += ["**Reply:**", "", "> " + (r["reply"].replace("\n", "\n> ") or "(empty)"), ""]
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
