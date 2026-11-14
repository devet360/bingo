import { io, type Socket } from 'socket.io-client';
import { getTokens } from './api';
import { getRuntimeConfig } from './runtime-config';

/**
 * The `auth` callback runs on every (re)connect, so a rotated access token is
 * picked up without recreating the socket.
 */
export function connectSocket(): Socket {
  return io(getRuntimeConfig().socketUrl, {
    auth: (cb) => cb({ token: getTokens()?.accessToken ?? '' }),
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    timeout: 10_000,
  });
}
