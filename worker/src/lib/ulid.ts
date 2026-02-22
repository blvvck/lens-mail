/** Lightweight ULID generator — no dependencies.
 *  Monotonic within the same millisecond. Lexicographically sortable.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford's Base32
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom = new Uint8Array(10);

export function ulid(): string {
  let now = Date.now();

  if (now === lastTime) {
    // Increment random portion for monotonicity
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] < 255) {
        lastRandom[i]++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    crypto.getRandomValues(lastRandom);
  }

  let str = '';

  // Encode timestamp (10 chars)
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    str = ENCODING[now % ENCODING_LEN] + str;
    now = Math.floor(now / ENCODING_LEN);
  }

  // Encode randomness (16 chars)
  for (let i = 0; i < lastRandom.length; i++) {
    str += ENCODING[lastRandom[i] % ENCODING_LEN];
    str += ENCODING[Math.floor(lastRandom[i] / ENCODING_LEN) % ENCODING_LEN];
  }

  return str.slice(0, 26); // ULID is always 26 chars
}
