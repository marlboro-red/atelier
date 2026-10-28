import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { creatorRequest } from "./agents/creator.js";

type Scope = { artifact?: string; creatorBridge?: string };
export async function enforceMcpScope(
  scope: Scope,
  name: string,
  args: { id?: string; filePath?: string; filePaths?: Record<string, string> },
  cwd = process.cwd(),
) {
  if (
    scope.artifact &&
    (["create_artifact", "duplicate_artifact"].includes(name) ||
      (args.id && args.id !== scope.artifact))
  )
    throw new Error(
      "This agent connection is scoped to artifact " + scope.artifact,
    );
  const owned = scope.creatorBridge
    ? await creatorRequest(scope.creatorBridge)
    : null;
  if (owned && args.id && !owned.includes(args.id))
    throw new Error(
      "This creator session can only access artifacts it created",
    );
  const files = args.filePaths
    ? Object.values(args.filePaths)
    : args.filePath
      ? [args.filePath]
      : [];
  if ((scope.artifact || scope.creatorBridge) && files.length) {
    const root = await realpath(cwd);
    for (const file of files) {
      const local = relative(root, await realpath(file));
      if (
        local === ".." ||
        local.startsWith("../") ||
        local.startsWith("..\\") ||
        isAbsolute(local)
      )
        throw new Error(
          "Scoped agent file inputs must be inside its working directory",
        );
    }
  }
  return owned;
}
