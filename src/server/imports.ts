import { parse } from "@babel/parser";
// Reject computed imports before esbuild can turn them into filesystem globs.
export function validateImports(source: string, filename: string) {
  const tree = parse(source, {
    sourceType: "unambiguous",
    createImportExpressions: true,
    attachComment: false,
    plugins: [
      ...(/\.tsx?$/.test(filename) ? ["typescript" as const] : []),
      ...(/\.[jt]sx$/.test(filename) ? ["jsx" as const] : []),
    ],
  });
  const nodes: any[] = [tree];
  while (nodes.length) {
    const node = nodes.pop();
    const isRequire =
      ["CallExpression", "OptionalCallExpression"].includes(node.type) &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require";
    const argument =
      node.type === "ImportExpression"
        ? node.source
        : isRequire
          ? node.arguments[0]
          : undefined;
    if (
      (node.type === "ImportExpression" || isRequire) &&
      !(
        argument?.type === "StringLiteral" ||
        (argument?.type === "TemplateLiteral" &&
          argument.expressions.length === 0)
      )
    )
      throw new Error(
        `Computed imports are blocked in ${filename}. Use literal paths to supplied artifact files.`,
      );
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) nodes.push(child);
      } else if (value && typeof value === "object" && "type" in value)
        nodes.push(value);
    }
  }
}
