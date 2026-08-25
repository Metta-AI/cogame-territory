// @cogweb/ui — slotted React primitives shared across cogame web clients.
// Game-specific bits arrive via render props; these components speak only the
// @cogweb/protocol wire contract. Import "@cogweb/ui/styles.css" for base styles.

export { instanceBasePath, spectatorWsUrl, portalLobbyUrl, isReplayView, viewerFeedSource } from "./wsUrl";
export type { PageLocation } from "./wsUrl";

export { useFeedStore, applyFrame, emptyFeedStore } from "./useFeedStore";
export type {
  FeedStore,
  FeedSocket,
  FeedStoreHandle,
  UseFeedStoreOptions,
} from "./useFeedStore";
export { loadReplayFrames } from "./replay";

export { Scrubber } from "./Scrubber";
export type { ScrubberProps } from "./Scrubber";

export { EventFeed } from "./EventFeed";
export type { EventFeedProps } from "./EventFeed";

export { AutopilotPanel } from "./AutopilotPanel";
export type { AutopilotPanelProps } from "./AutopilotPanel";

export { PlayerRoster } from "./PlayerRoster";
export type { PlayerRosterProps, RosterPlayer } from "./PlayerRoster";

export { SeatBar } from "./SeatBar";
export type { SeatBarProps, SeatPilotKind } from "./SeatBar";

export { PhaseIndicator } from "./PhaseIndicator";
export type { PhaseIndicatorProps, PhaseStep } from "./PhaseIndicator";

export { TopBar } from "./TopBar";
export type { TopBarProps } from "./TopBar";

export { SeatStatusBadge } from "./SeatStatusBadge";
export type { SeatStatusBadgeProps } from "./SeatStatusBadge";

export { Lobby } from "./Lobby";
export type { LobbyProps } from "./Lobby";

export { AutoAdvanceControl } from "./AutoAdvanceControl";
export type { AutoAdvanceControlProps } from "./AutoAdvanceControl";

export { AutoAdvanceSettings } from "./AutoAdvanceSettings";
export type { AutoAdvanceSettingsProps } from "./AutoAdvanceSettings";

// The viewer's persisted display name + the modal that collects it. Shared so the
// portal and every game console name a player from one identity (no "You" placeholder).
export { NamePrompt } from "./NamePrompt";
export type { NamePromptProps } from "./NamePrompt";
export { loadViewerName, saveViewerName } from "./viewerName";

// Unified in-game chrome (the "Game Top Bar" design): one top bar + one bottom
// scrubber bar every cogame mounts, plus the feed-drawer and autopilot-config
// overlays they float. Higher-level, opinionated composites over the primitives.
export { GameTopBar } from "./GameTopBar";
export type { GameTopBarProps, GameTopBarPlayer } from "./GameTopBar";

export { GameScrubberBar } from "./GameScrubberBar";
export type { GameScrubberBarProps, ScrubberMeta } from "./GameScrubberBar";

export { FeedDrawer } from "./FeedDrawer";
export type { FeedDrawerProps, FeedDrawerMessage } from "./FeedDrawer";

export { FeedView } from "./FeedView";
export type { FeedViewProps, FeedViewEvent, FeedEventType } from "./FeedView";

export { AutopilotConfig } from "./AutopilotConfig";
export type { AutopilotConfigProps, AutopilotPreset } from "./AutopilotConfig";

export { FinalScorePanel } from "./FinalScorePanel";
export type { FinalScorePanelProps } from "./FinalScorePanel";
