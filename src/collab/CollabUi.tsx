import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../ConfirmDialog";
import { explorerBasename, explorerParent } from "../fileNaming";
import type { Translate } from "../i18n";
import { Icon } from "../icons";
import { IS_TAURI } from "../platform";
import { getSetting, useSetting } from "../settingsStore";
import { useWorkspaceDirectories, useWorkspacePath } from "../workspaceStore";
import { joinRoom, leaveRoom, openRoom, showCollabDialog, useCollab } from "./collabStore";
import { DEVICES, openDevice, useDevice } from "./devices";
import { secondsLeft, KEYBOARD_IDLE_MS } from "./keyboard";
import { DEFAULT_RELAY_PORT, formatInvite, peerName, shortAddress } from "./protocol";

/** The name a cursor carries until the user gives one: a judge handle if there is one, since that is what teammates know each other by. */
const fallbackName = () => getSetting("atcoderHandle") || getSetting("codeforcesHandle") || getSetting("dojHandle") || `Player ${10 + Math.floor(Math.random() * 90)}`;

/** The status-bar entry: the way in while there is no room, and who is in it while there is one. */
export function CollabChip({ t }: { t: Translate }) {
  const phase = useCollab((state) => state.phase);
  const link = useCollab((state) => state.link);
  const members = useCollab((state) => state.members);
  if (phase !== "live") {
    return <button className={`lsp-status collab-status ${phase === "starting" ? "connecting" : "idle"}`} onClick={() => showCollabDialog("open")} title={t("collabChipHint")}><Icon name="users" size={13} />{t("collabChip")}</button>;
  }
  return <button className={`lsp-status collab-status ${link === "online" ? "ready" : "connecting"}`} onClick={() => showCollabDialog("room")}
    title={`${t("collabRoomTitle")} · ${link === "online" ? t("collabOnline") : t("collabOffline")}\n${members.map((member) => member.name).join(", ")}`}>
    <span />{t("collabRoom")}<em className="collab-faces">{members.map((member) => <i key={member.id} style={{ background: member.color }} />)}</em>
  </button>;
}

function CopyButton({ text, label, t }: { text: string; label?: string; t: Translate }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <button className="subtle-button collab-copy" title={t("collabCopy")} onClick={() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  }}><Icon name={copied ? "check" : "copy"} size={13} />{copied ? t("collabCopied") : label ?? t("collabCopy")}</button>;
}

const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => <label className="collab-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;

/** A folder of the workspace, picked from the ones it has; "" is the workspace itself. */
function FolderSelect({ value, onChange, root }: { value: string; onChange: (folder: string) => void; root: string }) {
  const directories = useWorkspaceDirectories();
  return <select value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">{root}</option>
    {[...directories].sort((left, right) => left.localeCompare(right)).map((directory) => <option key={directory} value={directory}>{directory}</option>)}
  </select>;
}

/** Opening a room and joining one: two halves of one dialog, since whoever opens it may have meant either. */
function StartDialog({ t, activeFilename, joining }: { t: Translate; activeFilename: string; joining: boolean }) {
  const starting = useCollab((state) => state.phase === "starting");
  const error = useCollab((state) => state.error);
  const workspacePath = useWorkspacePath();
  const directories = useWorkspaceDirectories();
  const [storedName, setStoredName] = useSetting("collabName");
  const [port, setPort] = useSetting("collabPort");
  const [relay, setRelay] = useSetting("collabRelay");
  const [fallback] = useState(fallbackName);
  const [name, setName] = useState(storedName);
  // The folder of the file in front is the one most likely meant.
  const [folder, setFolder] = useState(() => explorerParent(activeFilename));
  const [parent, setParent] = useState("");
  const [invite, setInvite] = useState("");
  // Off unless asked for: a room is for writing together, and the rule is for contests that keep it.
  const [icpc, setIcpc] = useState(false);
  const shown = peerName(name, fallback);
  const workspaceName = workspacePath ? explorerBasename(workspacePath) : "";
  // A folder that has gone since it was picked is not one to share.
  const known = (path: string) => path === "" || directories.includes(path) ? path : "";
  // The preview has no backend to listen with, so there a room can only be opened on a relay.
  const onRelay = !IS_TAURI || Boolean(relay.trim());

  const start = () => {
    setStoredName(name.trim());
    if (joining) void joinRoom({ invite, name: shown, parent: known(parent) });
    else void openRoom({ folder: known(folder), name: shown, relay: onRelay ? relay : null, port, icpc });
  };
  const ready = Boolean(workspacePath) && (joining ? Boolean(invite.trim()) : IS_TAURI || Boolean(relay.trim()));

  return <ConfirmDialog id="collab-start-title" eyebrow={t("collabRoom")} title={t("collabStartTitle")} cancel={t("cancel")} onCancel={() => showCollabDialog(null)}
    actions={<button className="primary-button" disabled={!ready || starting} onClick={start}>{joining ? starting ? t("collabJoining") : t("collabJoin") : starting ? t("collabOpening") : t("collabOpen")}</button>}>
    <form className="collab-form" onSubmit={(event) => { event.preventDefault(); if (ready && !starting) start(); }}>
      <div className="collab-switch" role="tablist">
        <button type="button" role="tab" aria-selected={!joining} className={joining ? "" : "active"} onClick={() => showCollabDialog("open")}>{t("collabOpenTab")}</button>
        <button type="button" role="tab" aria-selected={joining} className={joining ? "active" : ""} onClick={() => showCollabDialog("join")}>{t("collabJoinTab")}</button>
      </div>
      {workspacePath ? <p>{joining ? t("collabJoinHelp") : t("collabOpenHelp")}</p> : <p className="collab-warning">{t("collabErrNoWorkspace")}</p>}
      <Field label={t("collabName")}><input value={name} placeholder={fallback} maxLength={24} spellCheck={false} onChange={(event) => setName(event.target.value)} /></Field>
      {joining ? <>
        <Field label={t("collabInvite")}><input autoFocus value={invite} placeholder="192.168.0.7#K7QM-2XWP-9HDT" spellCheck={false} onChange={(event) => setInvite(event.target.value)} /></Field>
        <Field label={t("collabParent")} hint={t("collabParentHint")}><FolderSelect value={known(parent)} onChange={setParent} root={workspaceName} /></Field>
      </> : <>
        <Field label={t("collabFolder")}><FolderSelect value={known(folder)} onChange={setFolder} root={`${workspaceName} ${t("collabWholeWorkspace")}`} /></Field>
        <label className="collab-check"><input type="checkbox" checked={icpc} onChange={(event) => setIcpc(event.target.checked)} /><span>{t("collabIcpc")}<small>{t("collabIcpcHint")}</small></span></label>
        {/* A relay remembered from last time is in use, so it is shown, not folded away. */}
        <details className="collab-advanced" open={onRelay || undefined}>
          <summary>{t("collabAdvanced")}</summary>
          {IS_TAURI && <Field label={t("collabPort")}><input type="number" min={1024} max={65535} value={port} disabled={onRelay} onChange={(event) => setPort(Math.min(65535, Math.max(1024, Math.round(Number(event.target.value)) || DEFAULT_RELAY_PORT)))} /></Field>}
          <Field label={t("collabRelayAddress")} hint={IS_TAURI ? t("collabRelayHelp") : t("collabLocalAppOnly")}><input value={relay} placeholder="wss://relay.example.org" spellCheck={false} onChange={(event) => setRelay(event.target.value)} /></Field>
        </details>
      </>}
      {error && <p className="collab-error" role="alert">{t(error.message)}{error.detail ? `: ${error.detail}` : ""}</p>}
      {/* Enter in a field submits the form; the visible button lives in the footer. */}
      <button type="submit" hidden />
    </form>
  </ConfirmDialog>;
}

const REACH_MESSAGE = {
  checking: "collabReachChecking", open: "collabReachOpen", "no-gateway": "collabReachNoGateway", nat: "collabReachNat", refused: "collabReachRefused",
} as const;

/** The room while it is open: the one line a teammate needs, who is there, and the way out — the same for everyone in it. */
function RoomDialog({ t }: { t: Translate }) {
  const local = useCollab((state) => state.local);
  const link = useCollab((state) => state.link);
  const name = useCollab((state) => state.name);
  const root = useCollab((state) => state.root);
  const address = useCollab((state) => state.address);
  const lanAddresses = useCollab((state) => state.lanAddresses);
  const publicAddress = useCollab((state) => state.publicAddress);
  const reach = useCollab((state) => state.reach);
  const code = useCollab((state) => state.code);
  const members = useCollab((state) => state.members);
  const icpc = useCollab((state) => state.icpc);
  const holder = useCollab((state) => state.keyboard.holder);
  const device = useDevice();
  const workspacePath = useWorkspacePath();
  // On this computer the address the app itself uses is the loopback one, which is no use to anyone else.
  const addresses = [...(lanAddresses.length ? lanAddresses : [shortAddress(address)]), ...(publicAddress ? [publicAddress] : [])];
  const invite = formatInvite(addresses, code.replace(/-/g, ""));
  return <ConfirmDialog id="collab-room-title" eyebrow={t("collabRoom")} title={<>{t("collabRoomTitle")} · {name}</>} cancel={t("collabDone")} onCancel={() => showCollabDialog(null)}
    actions={<button className="danger-button" onClick={() => void leaveRoom()}>{local ? t("collabLeaveEnd") : t("collabLeave")}</button>}>
    <div className="collab-form">
      <p>{t("collabRoomHelp")}</p>
      {icpc && <p className="collab-rule"><Icon name="keyboard" size={14} /><span><strong>{t("collabIcpc")}</strong> {t("collabIcpcHint")}</span></p>}
      <div className="collab-field"><span>{t("collabInvite")}</span>
        <div className="collab-invite"><code>{invite}</code><CopyButton text={invite} t={t} /></div>
        {DEVICES && !device && <button className="subtle-button collab-copy" title={t("devDeviceHint")} onClick={() => void openDevice().catch(() => undefined)}><Icon name="users" size={13} />{t("devDeviceJoin")}</button>}
        {reach !== "none" && <small className={`collab-reach ${reach}`}>{t(REACH_MESSAGE[reach])}</small>}
      </div>
      <div className="collab-field"><span>{t("collabMyFolder")}</span>
        <div className="collab-path"><Icon name="folder" size={13} /><code>{root || (workspacePath ? explorerBasename(workspacePath) : "")}</code></div>
      </div>
      <div className="collab-field"><span>{t("collabMembers")} · <em className={link === "online" ? "online" : "offline"}>{link === "online" ? t("collabOnline") : t("collabOffline")}</em></span>
        <ul className="collab-members">
          {members.map((member) => <li key={member.id}><i style={{ background: member.color }} />{member.name}{member.self && <small>{t("collabYou")}</small>}{icpc && member.id === holder && <small className="writing"><Icon name="keyboard" size={11} />{t("collabKeyboardWriting")}</small>}</li>)}
        </ul>
      </div>
      <p className={local ? "collab-warning" : ""}>{local ? t("collabRoomLocalNote") : t("collabRoomRelayNote")}</p>
    </div>
  </ConfirmDialog>;
}

/** Every dialog of a room. `activeFilename` is the file in front, whose folder a new room is offered for. */
export function CollabDialogs({ t, activeFilename }: { t: Translate; activeFilename: string }) {
  const dialog = useCollab((state) => state.dialog);
  const live = useCollab((state) => state.phase === "live");
  if (dialog === "room" && live) return <RoomDialog t={t} />;
  if ((dialog === "open" || dialog === "join") && !live) return <StartDialog t={t} activeFilename={activeFilename} joining={dialog === "join"} />;
  return null;
}

/** A clock for a countdown: the time now, again every `every` ms while `running`. */
const useNow = (running: boolean, every = 200) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [running, every]);
  return now;
};

/** Under the ICPC rule, the status-bar entry for the keyboard: who writes, or that nobody does. */
export function KeyboardChip({ t }: { t: Translate }) {
  const icpc = useCollab((state) => state.phase === "live" && state.icpc);
  const keyboard = useCollab((state) => state.keyboard);
  const self = useCollab((state) => state.self);
  const members = useCollab((state) => state.members);
  const now = useNow(icpc && keyboard.holder !== null, 500);
  if (!icpc) return null;
  const holder = keyboard.holder === null ? null : members.find((member) => member.id === keyboard.holder);
  const left = secondsLeft(keyboard.until, now);
  const mine = keyboard.holder === self;
  const label = keyboard.holder === null ? t("collabKeyboardOpen") : mine ? t("collabKeyboardMine") : holder?.name ?? "?";
  const hint = keyboard.holder === null ? t("collabIcpcHint") : mine ? t("collabKeyboardMineHint") : t("collabKeyboardBusy").replace("{name}", holder?.name ?? "?");
  return <button className={`lsp-status keyboard-status ${keyboard.holder === null ? "free" : mine ? "mine" : "taken"}`} onClick={() => showCollabDialog("room")} title={hint}
    style={holder && !mine ? { ["--holder" as string]: holder.color } : undefined}>
    <Icon name={keyboard.holder === null || mine ? "keyboard" : "lock"} size={13} />{label}
    {keyboard.holder !== null && left < KEYBOARD_IDLE_MS / 1000 && <em>{left}s</em>}
  </button>;
}

/** How long "you can write now" stays up once the keyboard comes free. */
const FREED_FOR = 2600;

/**
 * Over the editor, while a shared file is in front: that somebody else has the keyboard and
 * how soon it is free — then, once it is, that this user may write again.
 */
export function KeyboardBanner({ t, shared }: { t: Translate; shared: boolean }) {
  const icpc = useCollab((state) => state.phase === "live" && state.icpc);
  const keyboard = useCollab((state) => state.keyboard);
  const self = useCollab((state) => state.self);
  const members = useCollab((state) => state.members);
  const blocked = icpc && keyboard.holder !== null && keyboard.holder !== self;
  const [freed, setFreed] = useState(false);
  const wasBlocked = useRef(false);
  useEffect(() => {
    if (blocked) { wasBlocked.current = true; setFreed(false); return; }
    if (!wasBlocked.current) return;
    wasBlocked.current = false;
    // Only a keyboard that comes free is news; taking it oneself is not.
    if (keyboard.holder !== null) return;
    setFreed(true);
    const timer = window.setTimeout(() => setFreed(false), FREED_FOR);
    return () => window.clearTimeout(timer);
  }, [blocked, keyboard.holder]);
  const now = useNow(blocked && shared, 100);
  if (!icpc || !shared) return null;
  if (blocked) {
    const holder = members.find((member) => member.id === keyboard.holder);
    const remaining = Math.max(0, keyboard.until - now);
    const left = secondsLeft(keyboard.until, now);
    return <div className="keyboard-banner taken" role="status" aria-live="polite" style={holder ? { ["--holder" as string]: holder.color } : undefined}>
      <Icon name="lock" size={14} />
      <span>{t("collabKeyboardBusy").replace("{name}", holder?.name ?? "?")}</span>
      {left < KEYBOARD_IDLE_MS / 1000 && <em>{t("collabKeyboardSoon").replace("{seconds}", String(left))}</em>}
      <i style={{ transform: `scaleX(${remaining / KEYBOARD_IDLE_MS})` }} />
    </div>;
  }
  if (freed) return <div className="keyboard-banner free" role="status" aria-live="polite"><Icon name="check" size={14} /><span>{t("collabKeyboardFree")}</span></div>;
  return null;
}
