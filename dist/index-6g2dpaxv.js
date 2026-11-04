import {
  formatGoalSummary2
} from "./index-br6qz0n5.js";
import {
  compactContinuationPrompt2,
  continuationPrompt2
} from "./index-s6646vjc.js";
import {
  CUSTOM_ENTRY_TYPE,
  replaceGoal2,
  updateGoalStatus2
} from "./index-h4gd6y3m.js";

// src/clipboard.ts
import { spawn } from "node:child_process";
var CLIPBOARD_TIMEOUT_MS = 5000;
function clipboardCommandsForPlatform(platform) {
  if (platform === "darwin") {
    return [{ command: "pbcopy", args: [] }];
  }
  if (platform === "win32") {
    return [
      { command: "clip.exe", args: [] },
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"]
      }
    ];
  }
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] }
  ];
}
function runClipboardCommand({ command, args }, text) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let settled = false;
    let stderr = "";
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, message: `${command} timed out` });
    }, CLIPBOARD_TIMEOUT_MS);
    child.on("error", (error) => {
      finish({ ok: false, message: error.message });
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin?.on("error", () => {});
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      const detail = stderr.trim();
      finish({ ok: false, message: detail ? `${command}: ${detail}` : `${command} exited with code ${code ?? "unknown"}` });
    });
    child.stdin?.end(text);
  });
}
async function copyTextToClipboard(text) {
  const commands = clipboardCommandsForPlatform(process.platform);
  const failures = [];
  for (const command of commands) {
    const result = await runClipboardCommand(command, text);
    if (result.ok) {
      return result;
    }
    failures.push(`${command.command}${result.message ? ` (${result.message})` : ""}`);
  }
  return {
    ok: false,
    message: `No clipboard command succeeded. Tried: ${failures.join(", ")}`
  };
}

// src/commands.ts
var COMMANDS = ["pause", "resume", "clear", "copy"];
function completions(prefix) {
  return COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
    value: command,
    label: command,
    description: `goal ${command}`
  }));
}
function queueGoalTurn(pi, goal, kind) {
  pi.sendMessage({
    customType: CUSTOM_ENTRY_TYPE,
    content: continuationPrompt2(goal),
    display: false,
    details: { kind, goalId: goal.goalId }
  }, { triggerTurn: true, deliverAs: "followUp" });
}
function queueGoalUserTurn(pi, goal) {
  pi.sendUserMessage(compactContinuationPrompt2(goal), { deliverAs: "followUp" });
}
async function handleGoalCommand2(pi, host, args, ctx, copyText = copyTextToClipboard) {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify(formatGoalSummary2(host.getGoal()));
    return;
  }
  if (trimmed === "clear") {
    const goal = host.getGoal();
    if (!goal) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    host.clearGoal("command", ctx);
    ctx.ui.notify("Goal cleared.");
    return;
  }
  if (trimmed === "copy") {
    const goal = host.getGoal();
    if (!goal) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    const result = await copyText(goal.objective);
    if (!result.ok) {
      ctx.ui.notify(result.message ? `Could not copy goal objective: ${result.message}` : "Could not copy goal objective.", "error");
      return;
    }
    ctx.ui.notify("Goal objective copied.");
    return;
  }
  if (trimmed === "pause" || trimmed === "resume") {
    const current = host.getGoal();
    if (trimmed === "resume" && current?.status === "active" && host.getGoalStartTurnStrategy() === "userFollowUp") {
      queueGoalUserTurn(pi, current);
      ctx.ui.notify("Goal already active; queued a continuation.");
      return;
    }
    const status = trimmed === "pause" ? "paused" : "active";
    const result = updateGoalStatus2(current, status);
    if (!result.ok || !result.goal) {
      ctx.ui.notify(result.message, "warning");
      return;
    }
    host.setGoal(result.goal, "command", ctx);
    ctx.ui.notify(result.message);
    if (trimmed === "resume" && result.goal.status === "active") {
      queueGoalUserTurn(pi, result.goal);
    }
    return;
  }
  const current = host.getGoal();
  if (current && current.status !== "complete") {
    if (!ctx.hasUI) {
      ctx.ui.notify("Clear the existing goal before replacing it.", "error");
      return;
    }
    const shouldReplace = await ctx.ui.confirm("Replace goal?", `Current goal:
${current.objective}

New goal:
${trimmed}`);
    if (!shouldReplace) {
      ctx.ui.notify("Goal unchanged.");
      return;
    }
  }
  const result = replaceGoal2(trimmed);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "error");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  if (host.getGoalStartTurnStrategy() === "userFollowUp") {
    queueGoalUserTurn(pi, result.goal);
  } else {
    queueGoalTurn(pi, result.goal, "command_start");
  }
}
function registerGoalCommand2(pi, host) {
  pi.registerCommand("goal", {
    description: "Show or manage the current Codex-style goal.",
    getArgumentCompletions(argumentPrefix) {
      return completions(argumentPrefix.trim());
    },
    async handler(args, ctx) {
      await handleGoalCommand2(pi, host, args, ctx);
    }
  });
}

export { handleGoalCommand2, registerGoalCommand2 };
