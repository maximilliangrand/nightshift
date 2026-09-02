// Never finishes, but looks busy the whole time.
let n = 0;
setInterval(() => console.log(`runaway: still working, iteration ${++n}`), 200);
