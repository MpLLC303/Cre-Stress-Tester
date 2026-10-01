// Entry point. Wiring only: the client projects the event log, the world draws it, the UI
// reads it. Nothing here invents state.
import { createClient } from './app.js';
import { createWorld } from './world.js';
import { createUI } from './ui.js';

const client = createClient();
const bootLine = document.getElementById('boot-line');
const stopBoot = client.onLink((link, detail) => {
  if (bootLine) bootLine.textContent = `LINKING TO STATION … ${detail || link} (retrying every second)`;
});
await client.ready;
stopBoot();

const boot = document.getElementById('boot');
if (boot) boot.remove();

const world = createWorld(document.getElementById('world'), client);
const ui = createUI(document.getElementById('ui'), client, world);

// Test hook used by scripts/ui-smoke.mjs (and handy in devtools). Read-only references.
window.__outpost = { client, world, ui };
