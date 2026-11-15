// Measures the longest JS turn (timer drift) while input keeps arriving over a thread of code blocks whose grammars are
// not built, then after input stops (idle builds). The result is drawn as text for shikiIdle.test.tsx.
import { mount, signal, Text, View } from "nsh";
import { ChatMarkdown } from "./ChatMarkdown";
import { noteUserInput } from "../../userActivity";
import { shikiLanguageWarm } from "./shikiHighlight";

const LANGS = ["ts", "python", "rust", "go", "json", "bash"];
const block = (lang: string, n: number) => `\`\`\`${lang}\n${Array.from({ length: 40 }, (_, i) => `const v${n}_${i} = f(${i}) // ${lang}`).join("\n")}\n\`\`\``;
// One message per block, as a thread has.
const rows = signal(LANGS.map((lang, i) => `Block ${i}\n\n${block(lang, i)}`));
const result = signal("measuring");

let worstActive = 0;
// The first idle slot after startup comes before any input; whatever built then is not "while active".
let warmAtStart = -1;
setTimeout(() => { warmAtStart = LANGS.filter((lang) => shikiLanguageWarm(lang)).length; noteUserInput(); last = Date.now(); worstActive = 0; }, 0);
let worstIdle = 0;
let phase: "active" | "idle" | "warm" = "active";
let last = Date.now();
const tick = setInterval(() => {
  if (phase === "warm") return;
  const now = Date.now();
  const turn = now - last - 10;
  if (turn > 50) console.log(`LONG ${phase} ${turn}ms at input ${count}`);
  if (phase === "active") worstActive = Math.max(worstActive, turn); else worstIdle = Math.max(worstIdle, turn);
  last = now;
}, 10);
// "Typing and scrolling": input every 100 ms for 4 s, with a new block appended every 400 ms (a row scrolled in).
let count = 0;
const typing = setInterval(() => {
  noteUserInput();
  count++;
  if (count % 4 === 0) { rows.set([...rows(), `More ${count}\n\n${block(LANGS[count % LANGS.length]!, count)}`]); }
  if (count >= 40) {
    clearInterval(typing);
    const builtWhileActive = LANGS.filter((lang) => shikiLanguageWarm(lang)).length - warmAtStart;
    phase = "idle";
    setTimeout(() => {
      clearInterval(tick);
      const built = LANGS.filter((lang) => shikiLanguageWarm(lang)).length;
      // Grammars built: input again while new blocks scroll in, which now tokenize (in slices) while active.
      let again = 0;
      let worstWarm = 0;
      phase = "warm";
      last = Date.now();
      const warmTick = setInterval(() => { const now = Date.now(); const turn = now - last - 10; if (turn > 50) console.log(`LONG warm ${turn}ms at ${again}`); worstWarm = Math.max(worstWarm, turn); last = now; }, 10);
      const typing2 = setInterval(() => {
        noteUserInput();
        again++;
        if (again % 3 === 0) { rows.set([...rows(), `Warm ${again}\n\n${block(LANGS[again % LANGS.length]!, 100 + again)}`]); }
        if (again >= 30) {
          clearInterval(typing2);
          setTimeout(() => { clearInterval(warmTick); result.set(`active max ${worstActive}ms, built while active ${builtWhileActive}; idle max ${worstIdle}ms, built ${built}/${LANGS.length}; warm active max ${worstWarm}ms`); }, 300);
        }
      }, 100);
    }, 2000 + LANGS.length * 700);
  }
}, 100);

mount(() => (
  <View>
    <Text>{result()}</Text>
    <Each of={rows()} key="index">{(row) => <ChatMarkdown text={row} />}</Each>
  </View>
));
