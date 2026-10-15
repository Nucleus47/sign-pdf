import { useEffect, useState } from 'react';
import { relayClient } from './relayClient.ts';

/**
 * True once this server has answered GET /relay/config: the email relay is
 * on. False on a static host, under the CLI, and when the Worker's RELAY_MODE
 * is off (docs/relay.md), which answers 404 like an unknown path. The home
 * page and the sign view show the email option only when this is true.
 */
export function useRelayAvailable(enabled = true): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    // Start from "no relay" each time the probe is (re)enabled: a stale "yes"
    // must not show the email option before the new answer arrives.
    setAvailable(false);
    if (!enabled) return;
    let live = true;
    void relayClient()
      .config()
      .then((config) => {
        if (live) setAvailable(config.ok);
      });
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled && available;
}
