// Plays a rendered route in: each segment draws from one stop to the next and a packet of light travels along it, at a
// pace that follows the real time between the stops (a slow hop drags); the stop where an order stopped pulses three
// times. Only what the check proved moves. With reduced motion, or without the Web Animations API, the finished
// picture (the default CSS) is all there is.

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const MAX_TOTAL_MS = 2_400;

/** 250–700 ms per segment, on a log scale of the seconds it took; 350 ms when the time is unknown. */
export function segmentMs(sec: number | null): number {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return 350;
  return Math.round(Math.min(700, 250 + 75 * Math.log10(1 + sec)));
}

export function playRoute(root: ParentNode): void {
  const fig = root.querySelector<HTMLElement>(".trace");
  if (!fig || typeof fig.animate !== "function") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // One play at a time: a replay asked for mid-play (the hero's hover) is ignored.
  if (fig.dataset["playing"] !== undefined) return;
  fig.dataset["playing"] = "";
  // Narrow containers stack the stops in one column (the CSS container query); the segments then run downwards.
  const list = fig.querySelector<HTMLElement>(".trace-stops");
  const vertical = list ? getComputedStyle(list).gridTemplateColumns.trim().split(/\s+/).length === 1 : false;
  const stops = [...fig.querySelectorAll<HTMLElement>(".tstop")];
  const segs = [...fig.querySelectorAll<HTMLElement>(".tseg")];

  // Only segments that lead somewhere the order went are played; unreached ones appear at the end.
  const played = segs.filter((s) => !s.classList.contains("unreached"));
  const raw = played.map((s) => segmentMs(s.dataset["sec"] ? Number(s.dataset["sec"]) : null));
  const scale = Math.min(1, (MAX_TOTAL_MS - 300) / Math.max(1, raw.reduce((a, b) => a + b, 0)));
  const durations = raw.map((d) => Math.round(d * scale));

  fig.classList.add("playing");
  const anims: Animation[] = [];
  const arrive = (stop: HTMLElement | undefined, at: number): void => {
    if (!stop) return;
    const node = stop.querySelector<HTMLElement>(".tnode");
    const label = stop.querySelector<HTMLElement>(".tlabel");
    if (node) anims.push(node.animate([{ opacity: 0.18, transform: "scale(0.7)" }, { opacity: 1, transform: "scale(1.12)", offset: 0.6 }, { opacity: 1, transform: "scale(1)" }], { duration: 420, delay: at, easing: EASE, fill: "both" }));
    if (label) anims.push(label.animate([{ opacity: 0.18, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 360, delay: at + 60, easing: EASE, fill: "both" }));
    if (node && stop.classList.contains("stopped")) {
      anims.push(node.animate([{ boxShadow: "0 0 0 0 rgba(255,176,32,0.65)" }, { boxShadow: "0 0 0 16px rgba(255,176,32,0)" }], { duration: 700, delay: at + 380, iterations: 3, easing: "ease-out" }));
    }
  };

  arrive(stops[0], 0);
  let t = 260;
  played.forEach((seg, i) => {
    const d = durations[i] ?? 350;
    const partial = seg.classList.contains("broken") || seg.classList.contains("waiting");
    const fill = seg.querySelector<HTMLElement>(".tfill");
    const packet = seg.querySelector<HTMLElement>(".tpacket");
    const axis = vertical ? "scaleY" : "scaleX";
    if (fill) anims.push(fill.animate([{ transform: `${axis}(0)` }, { transform: `${axis}(1)` }], { duration: d, delay: t, easing: EASE, fill: "both" }));
    if (packet) {
      const prop = vertical ? "top" : "left";
      const end = partial ? "55%" : "100%";
      anims.push(packet.animate([{ [prop]: "0%", opacity: 0 }, { opacity: 1, offset: 0.15 }, { [prop]: end, opacity: 1, offset: 0.85 }, { [prop]: end, opacity: 0 }], { duration: d + 120, delay: t, easing: "linear", fill: "both" }));
    }
    const dur = seg.querySelector<HTMLElement>(".tdur");
    if (dur) anims.push(dur.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: t + d * 0.6, fill: "both" }));
    t += d;
    const idx = segs.indexOf(seg) + 1;
    arrive(stops[idx], t - 40);
    if (partial) {
      // The broken remainder shows once the packet has halted.
      seg.classList.add("pending");
      const show = seg.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 1, delay: t });
      anims.push(show);
      show.finished.then(() => seg.classList.remove("pending")).catch(() => seg.classList.remove("pending"));
    }
    t += 60;
  });

  // Stops after a break, and the way back of a refund, come in last.
  const rest = stops.slice(played.length + 1);
  rest.forEach((stop) => {
    for (const el of stop.querySelectorAll<HTMLElement>(".tnode, .tlabel")) anims.push(el.animate([{ opacity: 0.18 }, { opacity: 1 }], { duration: 300, delay: t, fill: "both" }));
  });
  const back = fig.querySelector<SVGElement>(".treturn");
  if (back) anims.push(back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: t, fill: "both" }));

  const all = Promise.all(anims.map((a) => a.finished));
  // Hand the picture back to the CSS: it already shows the finished state.
  fig.classList.remove("playing");
  void all
    .then(() => {
      for (const a of anims) a.cancel();
    })
    .catch(() => undefined)
    .finally(() => delete fig.dataset["playing"]);
}
