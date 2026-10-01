import { randomBytes } from 'node:crypto';

let counter = 0;

/** Short, sortable-ish, collision-resistant id: `${prefix}_${time36}${counter36}${rand}`. */
export function newId(prefix) {
  counter = (counter + 1) % 1296;
  const time = Date.now().toString(36);
  const seq = counter.toString(36).padStart(2, '0');
  const rand = randomBytes(3).toString('hex');
  return `${prefix}_${time}${seq}${rand}`;
}
