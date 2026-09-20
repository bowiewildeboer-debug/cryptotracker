/**
 * VAPID public key for Web Push.
 *
 * This is PUBLIC by design - it identifies the sender to the push service and is meant to ship
 * in the client. The matching private key lives only in .env locally and in a GitHub Actions
 * secret; never commit that one.
 */
export const VAPID_PUBLIC_KEY = 'BO8w7GN5fO2WPCw3ZB17tqa-cGa1t4nJYr27vxq8mcQqxQq6TJe4ZSxfvfal9MWZQt7YOKdHoRl3kXLj3WivAUo';
