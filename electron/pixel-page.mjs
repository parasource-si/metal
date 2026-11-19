// the page a browser or a window shows when it hands someone back to the Metal app: a pixel sky, a bot on a speech
// card. no script, no fetched asset (callers use default-src 'none' with inline styles), so all art is inline svg.
// apps/link-service/src/handoff-page.mjs is a byte-identical copy: that service deploys alone, with no other files.

const SPRITES = {
  kit: ["M2 2h2v1h-2zM12 2h2v1h-2zM2 3h3v1h-3zM11 3h3v1h-3zM2 4h3v1h-3zM11 4h3v1h-3zM2 5h4v1h-4zM10 5h4v1h-4zM2 6h12v1h-12zM2 7h12v1h-12zM1 8h14v1h-14zM1 9h14v1h-14zM1 10h14v1h-14zM1 11h14v1h-14zM1 12h14v1h-14zM2 13h12v1h-12zM2 14h12v1h-12zM3 15h10v1h-10z", "M4 9h2v1h-2zM10 9h2v1h-2zM4 10h2v1h-2zM10 10h2v1h-2zM4 11h2v1h-2zM10 11h2v1h-2z"],
  goo: ["M7 4h2v1h-2zM5 5h6v1h-6zM4 6h8v1h-8zM4 7h8v1h-8zM3 8h10v1h-10zM3 9h10v1h-10zM3 10h10v1h-10zM1 11h14v1h-14zM1 12h14v1h-14zM1 13h14v1h-14zM1 14h14v1h-14zM3 15h10v1h-10z", "M5 9h2v1h-2zM9 9h2v1h-2zM5 10h2v1h-2zM9 10h2v1h-2zM5 11h2v1h-2zM9 11h2v1h-2z"],
  pip: ["M5 4h6v1h-6zM4 5h8v1h-8zM3 6h10v1h-10zM2 7h12v1h-12zM2 8h12v1h-12zM2 9h12v1h-12zM2 10h12v1h-12zM2 11h12v1h-12zM2 12h12v1h-12zM3 13h10v1h-10zM4 14h8v1h-8zM5 15h6v1h-6z", "M4 7h2v1h-2zM10 7h2v1h-2zM4 8h2v1h-2zM10 8h2v1h-2zM4 9h2v1h-2zM10 9h2v1h-2zM4 10h2v1h-2zM10 10h2v1h-2z"],
  mochi: ["M3 8h10v1h-10zM2 9h12v1h-12zM1 10h14v1h-14zM1 11h14v1h-14zM1 12h14v1h-14zM1 13h14v1h-14zM1 14h14v1h-14zM2 15h12v1h-12z", "M3 10h2v1h-2zM11 10h2v1h-2zM3 11h2v1h-2zM11 11h2v1h-2zM3 12h2v1h-2zM11 12h2v1h-2z"],
  hoot: ["M3 1h1v1h-1zM12 1h1v1h-1zM3 2h2v1h-2zM11 2h2v1h-2zM3 3h10v1h-10zM3 4h10v1h-10zM3 5h10v1h-10zM2 6h12v1h-12zM2 7h12v1h-12zM2 8h12v1h-12zM2 9h12v1h-12zM2 10h12v1h-12zM2 11h12v1h-12zM2 12h12v1h-12zM3 13h10v1h-10zM3 14h10v1h-10zM5 15h6v1h-6z", "M5 6h2v1h-2zM9 6h2v1h-2zM5 7h2v1h-2zM9 7h2v1h-2zM5 8h2v1h-2zM9 8h2v1h-2zM5 9h2v1h-2zM9 9h2v1h-2z"],
};

const SKY = [["#06bafd", 0], ["#3cd0fd", 10], ["#90e4fc", 28], ["#c2ecfc", 46], ["#eaf6fd", 54]];
const COLS = 120;
const ROWS = 80;
const GROUND = 64;

function skySvg(seed = 11) {
  let a = seed;
  const rand = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  const rects = [];
  const rect = (x, y, w, h, fill) => rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`);
  SKY.forEach(([fill, row], i) => rect(0, row, COLS, (SKY[i + 1]?.[1] ?? GROUND) - row, fill));
  for (const [fill, row] of SKY.slice(1)) {
    for (let x = 0; x < COLS;) {
      const run = 1 + Math.floor(rand() * 3);
      const h = [0, 0, 1, 1, 1, 2, 2, 3][Math.floor(rand() * 8)];
      if (h) rect(x, row - h, run, h, fill);
      if (rand() < 0.07) rect(x, row - h - 2, 1, 1, fill);
      x += run;
    }
  }
  for (const [cx, row, w, under] of [[18, 7, 16, "#ffc4dd"], [98, 14, 12, "#fff3a0"]]) {
    const x = cx - w / 2;
    rect(x + 2, row, w - 4, 1, "#fdfdfd");
    rect(x, row + 1, w, 2, "#fdfdfd");
    rect(x - 1, row + 3, w + 2, 1, under);
    rect(x + 1, row + 4, w - 2, 1, under);
  }
  rect(0, GROUND - 1, COLS, 1, "#d0cefb");
  rect(0, GROUND, COLS, ROWS - GROUND, "#c9f63f");
  for (let y = GROUND + 1; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (rand() < 0.05) rect(x, y, 1, 1, "#bde834");
  return `<svg class="sky" viewBox="0 0 ${COLS} ${ROWS}" preserveAspectRatio="xMidYMax slice" shape-rendering="crispEdges" aria-hidden="true">${rects.join("")}</svg>`;
}

const MOODS = {
  ok: { sprite: "kit", body: "#ffffff", eyes: "#212121" },
  go: { sprite: "pip", body: "#286ef9", eyes: "#ffffff" },
  oops: { sprite: "goo", body: "#f75e51", eyes: "#ffffff" },
};

/** `content` is trusted markup: callers escape every value they put in it */
export function handoffPage({ title, mood = "go", content, head = "" }) {
  const m = MOODS[mood];
  const [body, eyes] = SPRITES[m.sprite];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#06bafd">
<title>${title}</title>
${head}
<style>
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font-family:"General Sans",ui-rounded,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1b1b1f;background:#3cd0fd;-webkit-font-smoothing:antialiased}
.sky{position:fixed;inset:0;width:100%;height:100%}
main{position:relative;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:32px 20px 18vh}
.stack{width:100%;max-width:30rem;display:flex;flex-direction:column;align-items:center}
.bot{width:88px;height:88px;margin-bottom:-6px;position:relative}
.bot .eyes{transform-box:fill-box;transform-origin:50% 100%;animation:blink 3.6s steps(1,end) infinite}
@keyframes blink{0%,92%{transform:scaleY(1)}94%{transform:scaleY(.34)}97%{transform:scaleY(1)}}
.card-wrap{width:100%;filter:drop-shadow(6px 6px 0 #ffc4dd)}
.card{background:#fdfdfd;padding:28px 28px 26px;text-align:center;clip-path:polygon(0 6px,6px 6px,6px 0,calc(100% - 6px) 0,calc(100% - 6px) 6px,100% 6px,100% calc(100% - 6px),calc(100% - 6px) calc(100% - 6px),calc(100% - 6px) 100%,6px 100%,6px calc(100% - 6px),0 calc(100% - 6px))}
h1{margin:0;font-size:24px;line-height:1.2;font-weight:650;letter-spacing:-.02em}
p{margin:10px 0 0;font-size:15px;line-height:1.55;font-weight:600;color:#3a3a44}
a{color:#1b1b1f}
.go{margin:20px 0 0}.go a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 24px;background:#c9f63f;color:#1b1b1f;font-size:15px;font-weight:650;text-decoration:none;clip-path:polygon(0 4px,4px 4px,4px 0,calc(100% - 4px) 0,calc(100% - 4px) 4px,100% 4px,100% calc(100% - 4px),calc(100% - 4px) calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,4px calc(100% - 4px),0 calc(100% - 4px));transition:background-color .15s ease}
.go a:hover{background:#bde834}
.go a:active{transform:translateY(1px)}
.go a:focus-visible{outline:none;box-shadow:inset 0 0 0 3px #1b1b1f}
.hint{font-size:13px;margin-top:18px}
code{display:block;margin-top:8px;padding:10px 12px;background:#eaf6fd;font:600 12.5px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:#1b1b1f;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all;text-align:left}
@media(prefers-reduced-motion:reduce){.bot .eyes{animation:none}.go a{transition:none}}
</style>
</head>
<body>${skySvg()}<main><div class="stack"><svg class="bot" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true"><path fill="${m.body}" d="${body}"/><path class="eyes" fill="${m.eyes}" d="${eyes}"/></svg><div class="card-wrap"><div class="card">${content}</div></div></div></main></body>
</html>`;
}
