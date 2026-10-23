# Install the Atelier authoring skill

[atelier-artifacts](../skills/atelier-artifacts/SKILL.md) teaches agents how to choose a format, design a mixed-content page, preserve state in exports, and revise an existing artifact from comments. Its examples are patterns to adapt, not mandatory templates.

The skill is optional. Atelier's MCP server still supplies the essential runtime rules. Connect MCP and start Atelier using the [setup guide](../README.md#connect-your-agent) before asking an agent to create an artifact.

## Install for your agent

Copy the entire `skills/atelier-artifacts` folder, including `references` and `agents`, into your client's skills directory:

| Client | Personal skills directory | Project skills directory |
| --- | --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) | `~/.agents/skills/` | `.agents/skills/` |
| [Claude Code](https://code.claude.com/docs/en/skills#where-skills-live) | `~/.claude/skills/` | `.claude/skills/` |
| [Copilot in VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills) | `~/.copilot/skills/` | `.github/skills/` |
| [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills) | `~/.copilot/skills/` | `.github/skills/` |

Personal installs work across projects. Project installs belong in the project where you use the agent, which need not be Atelier's source repository. The final path must end in `atelier-artifacts/SKILL.md`, with its supporting folders alongside it.

On macOS or Linux, run the commands for your client from the cloned Atelier directory.

### Codex

```sh
mkdir -p ~/.agents/skills
cp -R skills/atelier-artifacts ~/.agents/skills/
```

### Claude Code

```sh
mkdir -p ~/.claude/skills
cp -R skills/atelier-artifacts ~/.claude/skills/
```

These are Claude Code paths. Claude Desktop's MCP configuration does not install this skill.

### GitHub Copilot

```sh
mkdir -p ~/.copilot/skills
cp -R skills/atelier-artifacts ~/.copilot/skills/
```

Copilot also discovers `~/.agents/skills/`, so you can skip this copy if you already installed there for Codex. Use one installation location to avoid duplicate entries.

On Windows, copy the folder to the equivalent directory under your user profile, or use the project directory from the table. No symlink is required.

## Use the skill

Start a new agent session after installation, then ask:

> Use the atelier-artifacts skill to create a report in Atelier with text, a diagram, and an interactive chart.

For an existing artifact:

> Use atelier-artifacts to read the comments on this artifact and revise it, preserving its ID: [artifact URL].

The agent can also select the skill automatically when a request matches its description. The skill does not grant new tool permissions or start a background agent.

After updating Atelier with `git pull`, copy the folder again to update the installed skill. Installing a skill does not make localhost reachable from a cloud agent; use a client that can reach your local Atelier service.
