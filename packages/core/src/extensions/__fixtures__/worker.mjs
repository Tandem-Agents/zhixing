let projection;
process.on("message", (frame) => {
  if (frame.kind !== "request") return;
  const reply = (payload) => process.send({ v: 1, kind: "response", id: frame.id, ok: true, payload });
  if (frame.method === "control.start") {
    projection = frame.payload.projection;
    if (projection.mode === "hang") return;
    if (projection.mode === "crash") process.exit(1);
    reply({ protocol: 1 });
  } else if (frame.method === "control.stop") {
    setTimeout(() => { reply(null); setImmediate(() => process.disconnect()); }, projection.mode === "slow-stop" ? 400 : 0);
  } else if (frame.method === "control.health") reply("ready");
  else if (frame.method === "fixture.echo") reply(frame.payload);
  else if (frame.method === "fixture.delayed") setTimeout(() => reply(frame.payload), 250);
  else if (frame.method === "fixture.crash") process.exit(1);
  else if (frame.method === "fixture.pid") reply(process.pid);
});
process.on("disconnect", () => process.exit(0));
