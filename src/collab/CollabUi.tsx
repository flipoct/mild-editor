import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../ConfirmDialog";
import { explorerBasename, explorerParent } from "../fileNaming";
import type { Translate } from "../i18n";
import { Icon } from "../icons";
import { IS_TAURI } from "../platform";
import { getSetting, useSetting } from "../settingsStore";
import { useWorkspaceDirectories, useWorkspacePath } from "../workspaceStore";
import { joinRoom, leaveRoom, openRoom, showCollabDialog, useCollab } from "./collabStore";
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
  const shown = peerName(name, fallback);
  const workspaceName = workspacePath ? explorerBasename(workspacePath) : "";
  // A folder that has gone since it was picked is not one to share.
  const known = (path: string) => path === "" || directories.includes(path) ? path : "";
  // The preview has no backend to listen with, so there a room can only be opened on a relay.
  const onRelay = !IS_TAURI || Boolean(relay.trim());

  const start = () => {
    setStoredName(name.trim());
    if (joining) void joinRoom({ invite, name: shown, parent: known(parent) });
    else void openRoom({ folder: known(folder), name: shown, relay: onRelay ? relay : null, port });
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
  const workspacePath = useWorkspacePath();
  // On this computer the address the app itself uses is the loopback one, which is no use to anyone else.
  const addresses = [...(lanAddresses.length ? lanAddresses : [shortAddress(address)]), ...(publicAddress ? [publicAddress] : [])];
  const invite = formatInvite(addresses, code.replace(/-/g, ""));
  return <ConfirmDialog id="collab-room-title" eyebrow={t("collabRoom")} title={<>{t("collabRoomTitle")} · {name}</>} cancel={t("collabDone")} onCancel={() => showCollabDialog(null)}
    actions={<button className="danger-button" onClick={() => void leaveRoom()}>{local ? t("collabLeaveEnd") : t("collabLeave")}</button>}>
    <div className="collab-form">
      <p>{t("collabRoomHelp")}</p>
      <div className="collab-field"><span>{t("collabInvite")}</span>
        <div className="collab-invite"><code>{invite}</code><CopyButton text={invite} t={t} /></div>
        {reach !== "none" && <small className={`collab-reach ${reach}`}>{t(REACH_MESSAGE[reach])}</small>}
      </div>
      <div className="collab-field"><span>{t("collabMyFolder")}</span>
        <div className="collab-path"><Icon name="folder" size={13} /><code>{root || (workspacePath ? explorerBasename(workspacePath) : "")}</code></div>
      </div>
      <div className="collab-field"><span>{t("collabMembers")} · <em className={link === "online" ? "online" : "offline"}>{link === "online" ? t("collabOnline") : t("collabOffline")}</em></span>
        <ul className="collab-members">
          {members.map((member) => <li key={member.id}><i style={{ background: member.color }} />{member.name}{member.self && <small>{t("collabYou")}</small>}</li>)}
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
