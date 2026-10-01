// STUB — replaced by the world engineer
// Minimal stand-in so the UI can be developed before the real world renderer lands.
// Draws room rectangles from station.json and maps clicks to rooms. Nothing here animates.

export function createWorld(canvas, client) {
  const ctx = canvas.getContext('2d');
  const selectFns = new Set();
  let focused = null;
  let raf = 0;

  function draw() {
    raf = 0;
    const st = client.state.station;
    const gw = st?.grid?.w || 56;
    const gh = st?.grid?.h || 33;
    const tile = st?.grid?.tile || 16;
    if (canvas.width !== gw * tile) canvas.width = gw * tile;
    if (canvas.height !== gh * tile) canvas.height = gh * tile;
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!st) return;
    for (const room of st.rooms) {
      const [x, y, w, h] = room.rect;
      ctx.fillStyle = '#0d1424';
      ctx.fillRect(x * tile, y * tile, w * tile, h * tile);
      ctx.strokeStyle = room.id === focused ? '#ffffff' : room.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x * tile + 1, y * tile + 1, w * tile - 2, h * tile - 2);
      ctx.fillStyle = room.color;
      ctx.font = '12px monospace';
      ctx.fillText(room.name.toUpperCase(), x * tile + 6, y * tile + 16);
    }
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
  const unsub = client.subscribe(schedule);
  schedule();

  function onClick(ev) {
    const st = client.state.station;
    if (!st) return;
    const r = canvas.getBoundingClientRect();
    const tile = st.grid.tile;
    const tx = Math.floor(((ev.clientX - r.left) / r.width) * st.grid.w);
    const ty = Math.floor(((ev.clientY - r.top) / r.height) * st.grid.h);
    const room = st.rooms.find((rm) => tx >= rm.rect[0] && tx < rm.rect[0] + rm.rect[2] && ty >= rm.rect[1] && ty < rm.rect[1] + rm.rect[3]);
    if (!room) return;
    void tile;
    for (const fn of selectFns) fn({ type: 'room', id: room.id });
  }
  canvas.addEventListener('click', onClick);

  return {
    onSelect(fn) { selectFns.add(fn); return () => selectFns.delete(fn); },
    focus(id) { focused = id; schedule(); },
    destroy() { unsub(); canvas.removeEventListener('click', onClick); if (raf) cancelAnimationFrame(raf); },
  };
}
