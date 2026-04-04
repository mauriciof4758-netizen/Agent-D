#!/usr/bin/env python3
"""
Autonomous web agent that can interact with browser windows.

Uses Claude AI (claude-opus-4-6) with the Playwright MCP server to autonomously
navigate and interact with websites — clicking, typing, scrolling, extracting
content, filling forms, and more.

Usage:
    python web_agent.py "Go to example.com and tell me the page title"
    python web_agent.py --verbose "Search for 'Claude AI' on wikipedia and summarize the first paragraph"
    python web_agent.py --headless "Fill out the contact form at example.com/contact"
"""

import argparse
import sys

import anyio
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    SystemMessage,
    TextBlock,
    query,
)

SYSTEM_PROMPT = """\
You are an autonomous web agent with full control over a real browser window.
You can navigate to URLs, click elements, type text, scroll, hover, take screenshots,
extract content, fill forms, and perform any browser interaction needed to complete tasks.

Guidelines:
- Break the task into clear, sequential browser actions
- Always verify an action succeeded before moving on (e.g. check the URL changed, the element appeared)
- If something fails, try an alternative approach (different selector, scroll first, wait, etc.)
- Extract and return the information the user asked for clearly and concisely
- When a task is complete, summarise what you did and what you found
"""


async def run_agent(task: str, verbose: bool = False, headless: bool = False) -> str:
    """
    Run the autonomous web agent.

    Args:
        task: Natural-language description of what the agent should do.
        verbose: Stream the agent's intermediate reasoning to stdout.
        headless: Run the browser without a visible window (headless mode).

    Returns:
        Final result text produced by the agent.
    """
    playwright_args = ["@playwright/mcp@latest"]
    if headless:
        playwright_args.append("--headless")

    options = ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        mcp_servers={
            "playwright": {
                "command": "npx",
                "args": playwright_args,
            }
        },
        max_turns=100,
        model="claude-opus-4-6",
    )

    result: str | None = None

    async for message in query(prompt=task, options=options):
        if isinstance(message, ResultMessage):
            result = message.result
        elif verbose:
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock) and block.text.strip():
                        print(block.text, flush=True)
            elif isinstance(message, SystemMessage) and message.subtype == "init":
                session_id = message.data.get("session_id", "unknown")
                print(f"[session: {session_id}]", flush=True)

    return result or "Task completed with no explicit result."


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Autonomous web agent powered by Claude AI + Playwright",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("task", help="Web task for the agent to perform")
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Stream the agent's reasoning to stdout",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run the browser in headless mode (no visible window)",
    )

    args = parser.parse_args()

    print(f"Task: {args.task}", flush=True)
    print("=" * 60, flush=True)

    try:
        result = anyio.run(run_agent, args.task, args.verbose, args.headless)
    except KeyboardInterrupt:
        print("\n[interrupted]")
        sys.exit(1)

    print("=" * 60)
    print("Result:")
    print(result)


if __name__ == "__main__":
    main()
