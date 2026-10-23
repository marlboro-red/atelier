process.once("message", () =>
  process.send({
    html: JSON.stringify({
      secret: process.env.ATELIER_TEST_SECRET,
      options: process.env.NODE_OPTIONS,
      cwd: process.cwd(),
      home: process.env.HOME,
    }),
  }),
);
