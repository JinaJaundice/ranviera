// A stand in for claude --version. FAKE_VERSION_MODE picks the behaviour.
const mode = process.env.FAKE_VERSION_MODE ?? "2.1.320 (Claude Code)";
if (mode === "hang") setTimeout(() => undefined, 60000);
else if (mode === "flood") process.stdout.write("x".repeat(100000));
else if (mode === "fail") process.exit(2);
else process.stdout.write(`${mode}\n`);
