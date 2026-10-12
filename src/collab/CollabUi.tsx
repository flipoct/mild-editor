import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { ConfirmDialog } from "../ConfirmDialog";
import type { Translate } from "../i18n";
import { Icon } from "../icons";
import { IS_TAURI } from "../platform";
import { getSetting, useSetting } from "../settingsStore";
import type { ProblemTab } from "../types";
import { answerTaken, closeRoomWithTab, joinRoom, leaveRoom, openRoom, showCollabDialog, useCollab } from "./collabStore";
import { DEFAULT_RELAY_PORT, formatInvite, parseInvite, peerName, shortAddress } from "./protocol";

type SharedTab = Pick<ProblemTab, "id" | "filename">;

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

const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="collab-field"><span>{label}</span>{children}</label>;

/** Opening a room and joining one: two halves of one dialog, since whoever opens it may have meant either. */
function StartDialog({ t, activeTab, joining }: { t: Translate; activeTab: SharedTab | undefined; joining: boolean }) {
  const starting = useCollab((state) => state.phase === "starting");
  const error = useCollab((state) => state.error);
  const [storedName, setStoredName] = useSetting("collabName");
  const [port, setPort] = useSetting("collabPort");
  const [relay, setRelay] = useSetting("collabRelay");
  const [fallback] = useState(fallbackName);
  const [name, setName] = useState(storedName);
  // The preview has no backend to listen with, so there a room can only be opened on a relay.
  const [local, setLocal] = useState(IS_TAURI);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const shown = peerName(name, fallback);

  const start = () => {
    setStoredName(name.trim());
    if (joining) void joinRoom({ address, code, name: shown });
    else if (activeTab) void openRoom({ tabId: activeTab.id, name: shown, relay: local ? null : relay, port });
  };
  /** An invitation pasted into either field fills both. */
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const invite = parseInvite(event.clipboardData.getData("text"));
    if (!invite.address || !invite.code) return;
    event.preventDefault();
    setAddress(invite.address);
    setCode(invite.code);
  };
  const ready = joining ? Boolean(address.trim() && code.trim()) : Boolean(activeTab && (local || relay.trim()));

  return <ConfirmDialog id="collab-start-title" eyebrow={t("collabRoom")} title={t("collabStartTitle")} cancel={t("cancel")} onCancel={() => showCollabDialog(null)}
    actions={<button className="primary-button" disabled={!ready || starting} onClick={start}>{joining ? starting ? t("collabJoining") : t("collabJoin") : starting ? t("collabOpening") : t("collabOpen")}</button>}>
    <form className="collab-form" onSubmit={(event) => { event.preventDefault(); if (ready && !starting) start(); }}>
      <div className="collab-switch" role="tablist">
        <button type="button" role="tab" aria-selected={!joining} className={joining ? "" : "active"} onClick={() => showCollabDialog("open")}>{t("collabOpenTab")}</button>
        <button type="button" role="tab" aria-selected={joining} className={joining ? "active" : ""} onClick={() => showCollabDialog("join")}>{t("collabJoinTab")}</button>
      </div>
      {joining ? <p>{t("collabJoinHelp")}</p>
        : activeTab ? <p>{t("collabSharing")} <strong>{activeTab.filename.split("/").at(-1)}</strong>. {t("collabOpenHelp")}</p>
        : <p className="collab-warning">{t("collabNoFile")}</p>}
      <Field label={t("collabName")}><input value={name} placeholder={fallback} maxLength={24} spellCheck={false} onChange={(event) => setName(event.target.value)} /></Field>
      {joining ? <>
        <Field label={t("collabAddress")}><input autoFocus value={address} placeholder={`192.168.0.7:${DEFAULT_RELAY_PORT}`} spellCheck={false} onPaste={paste} onChange={(event) => setAddress(event.target.value)} /></Field>
        <Field label={t("collabCode")}><input className="collab-code-input" value={code} placeholder="K7QM-2XWP-9HDT" spellCheck={false} autoCapitalize="characters" onPaste={paste} onChange={(event) => setCode(event.target.value)} /></Field>
      </> : <fieldset className="collab-where">
        <label className={IS_TAURI ? "" : "disabled"}>
          <input type="radio" name="collab-where" checked={local} disabled={!IS_TAURI} onChange={() => setLocal(true)} />
          <span><strong>{t("collabLocal")}</strong><small>{IS_TAURI ? t("collabLocalHelp") : t("collabLocalAppOnly")}</small></span>
          <input className="collab-port" type="number" min={1024} max={65535} value={port} disabled={!local} aria-label={t("collabPort")} title={t("collabPort")} onChange={(event) => setPort(Math.min(65535, Math.max(1024, Math.round(Number(event.target.value)) || DEFAULT_RELAY_PORT)))} />
        </label>
        <label>
          <input type="radio" name="collab-where" checked={!local} onChange={() => setLocal(false)} />
          <span><strong>{t("collabRelay")}</strong><small>{t("collabRelayHelp")}</small></span>
        </label>
        {!local && <input value={relay} placeholder="wss://relay.example.org" spellCheck={false} aria-label={t("collabRelayAddress")} onChange={(event) => setRelay(event.target.value)} />}
      </fieldset>}
      {error && <p className="collab-error" role="alert">{t(error.message)}{error.detail ? `: ${error.detail}` : ""}</p>}
      {/* Enter in a field submits the form; the visible button lives in the footer. */}
      <button type="submit" hidden />
    </form>
  </ConfirmDialog>;
}

const REACH_MESSAGE = {
  checking: "collabReachChecking", open: "collabReachOpen", "no-gateway": "collabReachNoGateway", nat: "collabReachNat", refused: "collabReachRefused",
} as const;

/** The room while it is open: how a teammate gets in, who is there, and the way out — the same for everyone in it. */
function RoomDialog({ t }: { t: Translate }) {
  const local = useCollab((state) => state.local);
  const link = useCollab((state) => state.link);
  const filename = useCollab((state) => state.filename);
  const address = useCollab((state) => state.address);
  const lanAddresses = useCollab((state) => state.lanAddresses);
  const publicAddress = useCollab((state) => state.publicAddress);
  const reach = useCollab((state) => state.reach);
  const code = useCollab((state) => state.code);
  const members = useCollab((state) => state.members);
  // On this computer the address the app itself uses is the loopback one, which is no use to anyone else.
  const addresses = [...(lanAddresses.length ? lanAddresses : [shortAddress(address)]), ...(publicAddress ? [publicAddress] : [])];
  const invite = formatInvite(addresses, code.replace(/-/g, ""));
  return <ConfirmDialog id="collab-room-title" eyebrow={t("collabRoom")} title={<>{t("collabRoomTitle")} · {filename}</>} cancel={t("collabDone")} onCancel={() => showCollabDialog(null)}
    actions={<button className="danger-button" onClick={() => void leaveRoom()}>{local ? t("collabLeaveEnd") : t("collabLeave")}</button>}>
    <div className="collab-form">
      <p>{t("collabRoomHelp")}</p>
      <div className="collab-field"><span>{t("collabInvite")}</span>
        <div className="collab-copy-row"><code className="collab-invite">{invite}</code><CopyButton text={invite} t={t} /></div>
        {reach !== "none" && <small className={`collab-reach ${reach}`}>{t(REACH_MESSAGE[reach])}</small>}
      </div>
      <div className="collab-field"><span>{t("collabAddress")}</span>
        {addresses.map((item) => <div className="collab-copy-row" key={item}><code>{item}</code>{item === publicAddress && <small>{t("collabPublic")}</small>}<CopyButton text={item} t={t} /></div>)}
      </div>
      <div className="collab-field"><span>{t("collabCode")}</span>
        <div className="collab-copy-row"><code className="collab-code">{code}</code><CopyButton text={code} t={t} /></div>
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

/** Every dialog of a room. `activeTab` is the file a new room would start from. */
export function CollabDialogs({ t, activeTab }: { t: Translate; activeTab: SharedTab | undefined }) {
  const dialog = useCollab((state) => state.dialog);
  const live = useCollab((state) => state.phase === "live");
  const taken = useCollab((state) => state.taken);
  if (dialog === "taken" && taken) {
    const name = taken.filename.split("/").at(-1) || taken.filename;
    return <ConfirmDialog id="collab-taken-title" eyebrow={t("collabRoom")} title={t("collabTakenTitle").replace("{name}", name)} cancel={t("cancel")} onCancel={() => answerTaken(null)}
      actions={<><button className="subtle-button" onClick={() => answerTaken("copy")}>{t("collabTakenCopy")}</button><button className="danger-button" onClick={() => answerTaken("replace")}>{t("collabTakenReplace")}</button></>}>
      <p>{t("collabTakenBody").replace("{copy}", taken.copyName.split("/").at(-1) || taken.copyName)}</p>
    </ConfirmDialog>;
  }
  if (dialog === "close" && live) {
    return <ConfirmDialog id="collab-close-title" eyebrow={t("collabRoom")} title={t("collabCloseTitle")} cancel={t("cancel")} onCancel={() => showCollabDialog(null)}
      actions={<button className="danger-button" autoFocus onClick={() => void closeRoomWithTab()}>{t("collabCloseConfirm")}</button>}>
      <p>{t("collabCloseBody")}</p>
    </ConfirmDialog>;
  }
  if (dialog === "room" && live) return <RoomDialog t={t} />;
  if ((dialog === "open" || dialog === "join") && !live) return <StartDialog t={t} activeTab={activeTab} joining={dialog === "join"} />;
  return null;
}
