// The dialog field takes typing after a press, and an outside value change still reaches it (props pass through).
import { expect, open, test } from "nsh/test";

test("typing into a DialogInput updates the value, and a value set from outside shows", async () => {
  const app = await open("./DialogInputFixture.tsx");
  await app.type("label:Name", "abc");
  await app.waitFor("text:value=[abc] focused=true");
  await app.press("label:Fill");
  await app.waitFor("text:value=[from server] focused=true");
  await app.type("label:Name", "!");
  await app.waitFor("text:value=[from server!] focused=true");
});
