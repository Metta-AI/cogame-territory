// Shared art icon: renders one of the luminous neon-glass Territory sprites from
// src/client/icons/transparent/ (alpha-keyed, so they sit on any dark surface).
// Imported through vite (inlined as data URIs) so the icons render under every
// serving shape — the Observatory proxy and the static replay bundle included,
// where a path-served asset 404s.
import React from "react";

import crackedIcon from "./icons/transparent/cracked.png";
import hearthIcon from "./icons/transparent/hearth.png";
import logoIcon from "./icons/transparent/logo.png";
import paintIcon from "./icons/transparent/paint-splatter.png";
import rubbleIcon from "./icons/transparent/rubble.png";
import skullIcon from "./icons/transparent/skull.png";
import wallRichIcon from "./icons/transparent/wall-rich.png";
import wallIcon from "./icons/transparent/wall.png";

export type IconName =
  | "wall"
  | "wall-rich"
  | "cracked"
  | "rubble"
  | "paint-splatter"
  | "hearth"
  | "skull"
  | "logo";

export const iconSrc: Record<IconName, string> = {
  wall: wallIcon,
  "wall-rich": wallRichIcon,
  cracked: crackedIcon,
  rubble: rubbleIcon,
  "paint-splatter": paintIcon,
  hearth: hearthIcon,
  skull: skullIcon,
  logo: logoIcon,
};

/** The sprite for a tile: yield is the wall sprite's weight, 1–3. */
export const tileSprite = (state: string, tileYield: number): IconName | null => {
  if (state === "rubble") return "rubble";
  if (state === "cracked") return "cracked";
  return tileYield >= 2 ? "wall-rich" : "wall";
};

export function Icon({
  name,
  size = 20,
  title,
}: {
  name: IconName;
  size?: number;
  title?: string;
}): React.ReactElement {
  return (
    <img className="icon" src={iconSrc[name]} width={size} height={size} alt={title ?? name} draggable={false} />
  );
}
