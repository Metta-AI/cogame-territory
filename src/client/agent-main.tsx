// Per-seat console entry. The coworld host serves this bundle on
// `/client/player?slot=&token=`; which seat it follows comes from that URL, which
// <App/> reads via its own router. The certifier probes GET /client/player BEFORE
// any player pod starts and a 404 there fails the episode (lantern 0.1.1), so this
// entry must keep building even though the replay page never links to it.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
