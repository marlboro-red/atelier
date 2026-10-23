// Resource permissions for generated code, including sandboxed HTML exports.
export const artifactPolicy =
  "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data: https://fonts.googleapis.com; img-src data: blob:; font-src data: https://fonts.gstatic.com; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

// This must be enforced by the embedding document: the child's own frame-src
// directive does not restrict its self-navigation.
export function workspacePolicy() {
  return "frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
}
