import "tsx/esm";
// Only the parent supplies input. Artifact code is compiled, never evaluated here.
process.once("message", async (input) => {
  try {
    const { render } = await import("./render.ts");
    const html = await render(...input);
    if (Buffer.byteLength(html) > 64 * 1024 * 1024)
      throw new Error("Rendered document exceeds 64 MiB");
    process.send({ html });
  } catch (error) {
    process.send({ error: String(error?.message ?? error).slice(0, 4000) });
  }
});
process.on("disconnect", () => process.exit());
