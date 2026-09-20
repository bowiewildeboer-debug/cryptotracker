/**
 * Web Push sign-up, with no backend.
 *
 * The daily job runs in GitHub Actions and needs the PushSubscription to send anything. There
 * is no server to POST it to, and putting a GitHub write token in the browser is not an option:
 * `<user>.github.io` is a single origin shared by every Pages project on the account, so any
 * XSS in an unrelated project could read that token and rewrite this repo's secrets.
 *
 * So the subscription is pasted once into a GitHub Actions secret. Its one weakness is silent
 * expiry, and that is covered from both ends: this file compares the live subscription against
 * the one you pasted every time the app opens, and the sending job opens a GitHub issue when a
 * push comes back 404 or 410.
 */
import { VAPID_PUBLIC_KEY } from './push-config.js';

const PASTED_KEY = 'cryptotracker.pastedSub.v1';

/** The push API wants the key as bytes; handing it the base64url string fails silently. */
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normal = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normal);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const read = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('./');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Must be called from inside a click handler: browsers reject a permission prompt otherwise. */
export async function enablePush() {
  if (!pushSupported()) {
    throw new Error(
      'Deze browser ondersteunt geen meldingen. Op een iPhone moet je de app eerst via Deel > Zet op beginscherm installeren en daarna vanaf dat icoon openen.',
    );
  }

  const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Meldingen zijn geblokkeerd. De browser vraagt het niet nog een keer; zet het terug via het slotje of instellingen naast de adresbalk.'
        : 'Je hebt de vraag weggeklikt. Probeer het opnieuw.',
    );
  }

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      // Mandatory on Chrome, Edge and Firefox. A push that shows nothing also gets the
      // subscription revoked outright on iOS, so this is the only sane mode anyway.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }));

  return JSON.stringify(sub.toJSON());
}

export function markPasted(json) {
  write(PASTED_KEY, json);
}

/**
 * Has the subscription changed since it was pasted into the secret?
 *
 * Chrome never fires `pushsubscriptionchange`, so without this check a rotated subscription
 * would fail silently until someone noticed the notifications had stopped.
 */
export async function subscriptionDrift() {
  const sub = await currentSubscription();
  if (!sub) return read(PASTED_KEY) ? 'gone' : 'none';
  const live = JSON.stringify(sub.toJSON());
  const pasted = read(PASTED_KEY);
  if (!pasted) return 'not-pasted';
  return live === pasted ? 'ok' : 'changed';
}

export async function unsubscribe() {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe();
  try {
    localStorage.removeItem(PASTED_KEY);
  } catch {
    /* ignore */
  }
}
