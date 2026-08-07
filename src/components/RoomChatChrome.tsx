import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { mockModels } from "../data/mock";
import type { ChatAttachment, ModelOption, ReasoningSummary } from "../domain/ocean";
import { OceanBottomSheet } from "./OceanBottomSheet";
import { OceanGatewayClient, type OpenRouterBalance } from "../api/OceanGatewayClient";
import { gatewayIsConnected } from "../sync/gatewaySync";
import { getModelSelection, setModelSelection } from "../config/modelSelection";
import { readUsageLedger, type UsageLedger } from "../data/usageLedger";
import { assetPath } from "../utils/assetPath";
import type { MusicPlaylist, MusicTrack } from "../domain/music";

type ToolPanel = "music" | "model" | "usage" | "attachments" | "connectors" | null;
type PlayMode = "single" | "list" | "shuffle";
type ModelField = "model" | "profile" | `setting:${string}` | null;

export interface RoomAttachmentAction {
  id: string;
  icon: string;
  label: string;
}

interface RoomChatChromeProps {
  attachmentActions?: RoomAttachmentAction[];
  input: string;
  inputPlaceholder?: string;
  nightTalk?: boolean;
  modelLabelOverride?: string;
  onAttachmentAction?: (id: string) => void;
  onInputChange: (value: string) => void;
  onModelClick?: () => void;
  onNightTalkChange?: (value: boolean) => void;
  onSend: (attachments: ChatAttachment[]) => void;
  reasoning?: ReasoningSummary | null;
  sendDisabled?: boolean;
  storageRemainingPercent?: number;
  variant?: "living" | "study";
}

const WHEEL_ROW_HEIGHT = 22;
const livingAsset = (name: string) => assetPath(`assets/living/${name}`);

function compactModelName(model: Pick<ModelOption, "id" | "name" | "upstreamModelId">) {
  const identity = `${model.id} ${model.upstreamModelId ?? ""} ${model.name}`;
  if (/claude[-/]sonnet[-.]?4[-.]?6|claude-sonnet-4\.6/i.test(identity)) return "Sonnet 4.6";
  if (/claude[-/]opus[-.]?4[-.]?8|claude-opus-4\.8/i.test(identity)) return "Opus 4.8";
  if (/deepseek[- ]?v?4[- ]?flash/i.test(identity)) return "DeepSeek V4 Flash";
  if (/deepseek[- ]?v?4[- ]?pro/i.test(identity)) return "DeepSeek V4 Pro";
  if (/openrouter[/-]auto/i.test(identity)) return "OpenRouter Auto";
  return model.name.replace(/^Claude\s+/i, "").replace(/^通义\s*/i, "Qwen ").trim();
}

function formatCost(value: number | undefined, currency?: string, estimated = false) {
  if (value === undefined) return "—";
  const digits = value < 0.0001 ? 6 : value < 1 ? 4 : 2;
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency ?? ""} `;
  return `${estimated ? "≈" : ""}${symbol}${value.toFixed(digits)}`;
}

function formatCache(inputTokens: number, cachedTokens: number) {
  if (inputTokens <= 0) return cachedTokens.toLocaleString();
  return `${cachedTokens.toLocaleString()} · ${Math.round((cachedTokens / inputTokens) * 100)}%`;
}

const defaultAttachmentActions: RoomAttachmentAction[] = [
  { id: "camera", icon: livingAsset("plus-camera.svg"), label: "拍照" },
  { id: "picture", icon: livingAsset("plus-picture.svg"), label: "图片" },
  { id: "file", icon: livingAsset("plus-file.svg"), label: "文件" },
  { id: "connector", icon: livingAsset("plus-connector.svg"), label: "连接器" },
];

function WheelColumn({ ariaLabel, items, value, onChange }: { ariaLabel: string; items: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | null>(null);

  useEffect(() => {
    const index = Math.max(0, items.findIndex((item) => item.id === value));
    const frame = window.requestAnimationFrame(() => listRef.current?.scrollTo({ top: index * WHEEL_ROW_HEIGHT }));
    return () => window.cancelAnimationFrame(frame);
  }, [items, value]);

  const settle = () => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const node = listRef.current;
      if (!node) return;
      const index = Math.min(items.length - 1, Math.max(0, Math.round(node.scrollTop / WHEEL_ROW_HEIGHT)));
      const item = items[index];
      node.scrollTo({ top: index * WHEEL_ROW_HEIGHT, behavior: "smooth" });
      if (item && item.id !== value) onChange(item.id);
    }, 90);
  };

  return (
    <div aria-label={ariaLabel} aria-activedescendant={`${ariaLabel}-${value}`} className="model-wheel" onScroll={settle} ref={listRef} role="listbox" tabIndex={0}>
      {items.map((item) => (
        <button aria-selected={item.id === value} className={item.id === value ? "selected" : ""} id={`${ariaLabel}-${item.id}`} key={item.id} onClick={() => onChange(item.id)} role="option">
          {item.label}
        </button>
      ))}
    </div>
  );
}

const MUSIC_ROW_HEIGHT = 13;
const MUSIC_CYCLES = 5;

function MusicWheel({ items, value, onChange, onActivate }: { items: MusicTrack[]; value: number; onChange: (value: number) => void; onActivate: (value: number) => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const itemCount = Math.max(items.length, 1);
  const middleStart = Math.floor(MUSIC_CYCLES / 2) * itemCount;
  const [virtualIndex, setVirtualIndex] = useState(middleStart + value);
  const rows = items.length ? Array.from({ length: items.length * MUSIC_CYCLES }, (_, index) => ({ index, songIndex: index % items.length })) : [];

  useLayoutEffect(() => {
    const next = middleStart + value;
    setVirtualIndex(next);
    if (viewport.current) viewport.current.scrollTop = next * MUSIC_ROW_HEIGHT;
  }, [middleStart, value, items.length]);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const settle = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!viewport.current) return;
      const raw = Math.max(0, Math.min(rows.length - 1, Math.round(viewport.current.scrollTop / MUSIC_ROW_HEIGHT)));
      if (!items.length) return;
      const songIndex = raw % items.length;
      setVirtualIndex(raw);
      if (songIndex !== value) onChange(songIndex);
      viewport.current.scrollTo({ top: raw * MUSIC_ROW_HEIGHT, behavior: "smooth" });
      if (raw < items.length || raw >= rows.length - items.length) {
        const recentered = middleStart + songIndex;
        window.setTimeout(() => {
          setVirtualIndex(recentered);
          if (viewport.current) viewport.current.scrollTop = recentered * MUSIC_ROW_HEIGHT;
        }, 140);
      }
    }, 90);
  };

  return <div aria-label="歌曲滚轮" className="music-track-list" onScroll={settle} ref={viewport} role="listbox" tabIndex={0}>
    {rows.map((row) => <button aria-selected={row.index === virtualIndex} className={row.index === virtualIndex ? "selected" : ""} key={`${items[row.songIndex]?.id}-${row.index}`} onClick={() => { viewport.current?.scrollTo({ top: row.index * MUSIC_ROW_HEIGHT, behavior: "smooth" }); if (row.index === virtualIndex) onActivate(row.songIndex); }} role="option" title={items[row.songIndex]?.artists.join(" / ")}>{items[row.songIndex]?.name}</button>)}
  </div>;
}

function MusicPlaylistTitle({ name }: { name: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    const update = () => {
      const node = viewport.current;
      const styles = node ? window.getComputedStyle(node) : null;
      const viewportWidth = node
        ? node.clientWidth - Number.parseFloat(styles?.paddingLeft ?? "0") - Number.parseFloat(styles?.paddingRight ?? "0")
        : 0;
      const labelWidth = label.current?.scrollWidth ?? 0;
      setShift(Math.max(0, labelWidth - viewportWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    if (label.current) observer.observe(label.current);
    return () => observer.disconnect();
  }, [name]);

  return (
    <div
      className={`music-playlist-title ${shift > 0 ? "scrolling" : ""}`}
      ref={viewport}
      style={{ "--music-title-shift": `${shift}px` } as CSSProperties}
      title={name}
    >
      <span key={name} ref={label}>{name}</span>
    </div>
  );
}

async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const id = crypto.randomUUID();
  if (file.size > 8_000_000) throw new Error("单个附件暂时不能超过 8 MB");
  if (file.type.startsWith("image/")) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败"));
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
    const previewDataUrl = await createImagePreview(data);
    return { id, kind: "image", name: file.name || "相机照片", mimeType: file.type || "image/jpeg", size: file.size, data, previewDataUrl };
  }
  const textLike = file.type.startsWith("text/") || /\.(txt|md|markdown|json|csv)$/i.test(file.name);
  if (!textLike) throw new Error("文件附件目前先支持 TXT、Markdown、JSON 与 CSV");
  if (file.size > 1_000_000) throw new Error("文本附件暂时不能超过 1 MB");
  return { id, kind: "text", name: file.name, mimeType: file.type || "text/plain", size: file.size, data: await file.text() };
}

async function createImagePreview(dataUrl: string) {
  if (dataUrl.length <= 650_000) return dataUrl;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const node = new Image();
    node.onload = () => resolve(node);
    node.onerror = () => reject(new Error("图片预览生成失败"));
    node.src = dataUrl;
  });
  const maxEdge = 1_280;
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("图片预览生成失败");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export function RoomChatChrome({
  attachmentActions = defaultAttachmentActions,
  input,
  inputPlaceholder = "",
  nightTalk = false,
  modelLabelOverride,
  onAttachmentAction,
  onInputChange,
  onModelClick,
  onNightTalkChange,
  onSend,
  reasoning,
  sendDisabled = false,
  storageRemainingPercent,
  variant = "living",
}: RoomChatChromeProps) {
  const [panel, setPanel] = useState<ToolPanel>(null);
  const [models, setModels] = useState<ModelOption[]>(mockModels);
  const [model, setModel] = useState<ModelOption>(() => mockModels.find((item) => item.id === "opus-48") ?? mockModels[0]);
  const [profileId, setProfileId] = useState(() => (mockModels.find((item) => item.id === "opus-48") ?? mockModels[0]).profiles[0].id);
  const [modelField, setModelField] = useState<ModelField>(null);
  const [modelSettings, setModelSettings] = useState<Record<string, string>>(() => Object.fromEntries((mockModels.find((item) => item.id === "opus-48") ?? mockModels[0]).settings.map((setting) => [setting.id, setting.defaultValue])));
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [playlist, setPlaylist] = useState(0);
  const [track, setTrack] = useState(0);
  const [playMode, setPlayMode] = useState<PlayMode>("list");
  const [musicConnection, setMusicConnection] = useState<"idle" | "loading" | "connected" | "disconnected" | "error">("idle");
  const [musicPlaylists, setMusicPlaylists] = useState<MusicPlaylist[]>([]);
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([]);
  const [musicNotice, setMusicNotice] = useState("");
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [connectors, setConnectors] = useState<Array<{ id: string; configured: boolean; provider: string }>>([]);
  const cameraInput = useRef<HTMLInputElement>(null);
  const pictureInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioPlayer = useRef<HTMLAudioElement>(null);
  const [usage, setUsage] = useState<UsageLedger>(readUsageLedger);
  const [openRouterBalance, setOpenRouterBalance] = useState<OpenRouterBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const latestCurrency = usage.latest?.currency?.toUpperCase() ?? usage.currency;
  const dailyCost = latestCurrency ? usage.dailyCosts[latestCurrency] : undefined;
  const modelName = compactModelName(model);
  const displayedModelName = modelLabelOverride ?? modelName;

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!gatewayIsConnected()) return;
      try {
        const available = await new OceanGatewayClient().listModels();
        if (!active || available.length === 0) return;
        setModels(available);
        const saved = getModelSelection();
        const next = available.find((item) => item.id === saved?.modelId) ?? available.find((item) => item.providerId === saved?.providerId) ?? available[0];
        if (!next) return;
        setModel(next);
        setProfileId(next.profiles[0]?.id ?? "default");
        setModelSettings({ ...Object.fromEntries(next.settings.map((setting) => [setting.id, setting.defaultValue])), ...(saved?.settings ?? {}) });
      } catch { /* Keep the high-fidelity mock picker available offline. */ }
    };
    void load();
    window.addEventListener("ocean:providers-changed", load);
    return () => { active = false; window.removeEventListener("ocean:providers-changed", load); };
  }, []);

  useEffect(() => {
    if (panel !== "connectors") return;
    void new OceanGatewayClient().listConnectors().then((items) => setConnectors(items)).catch(() => setConnectors([]));
  }, [panel]);

  useEffect(() => {
    if (panel !== "music") return;
    let active = true;
    const load = async () => {
      setMusicConnection("loading");
      setMusicNotice("");
      try {
        const client = new OceanGatewayClient();
        const status = await client.musicStatus();
        if (!active) return;
        if (!status.connected) {
          setMusicConnection("disconnected");
          setMusicPlaylists([]);
          setMusicTracks([]);
          return;
        }
        const lists = await client.listMusicPlaylists();
        if (!active) return;
        setMusicPlaylists(lists);
        setPlaylist((current) => Math.min(current, Math.max(0, lists.length - 1)));
        setMusicConnection("connected");
      } catch {
        if (active) setMusicConnection("error");
      }
    };
    void load();
    window.addEventListener("ocean:music-changed", load);
    return () => { active = false; window.removeEventListener("ocean:music-changed", load); };
  }, [panel]);

  useEffect(() => {
    if (musicConnection !== "connected") return;
    const selected = musicPlaylists[playlist];
    if (!selected) {
      setMusicTracks([]);
      return;
    }
    let active = true;
    setMusicNotice("正在打开歌单…");
    void new OceanGatewayClient().listMusicTracks(selected.id).then((items) => {
      if (!active) return;
      setMusicTracks(items);
      setTrack(0);
      setMusicNotice(items.length ? "" : "这个歌单暂时没有可显示的歌曲");
    }).catch(() => {
      if (!active) return;
      setMusicTracks([]);
      setMusicNotice("歌单暂时没有打开");
    });
    return () => { active = false; };
  }, [musicConnection, musicPlaylists, playlist]);

  useEffect(() => {
    if (!attachmentNotice) return;
    const timer = window.setTimeout(() => setAttachmentNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [attachmentNotice]);

  useEffect(() => {
    const update = (event: Event) => setUsage((event as CustomEvent<UsageLedger>).detail ?? readUsageLedger());
    window.addEventListener("ocean:usage-updated", update);
    return () => window.removeEventListener("ocean:usage-updated", update);
  }, []);

  useEffect(() => {
    if (panel !== "usage" || !gatewayIsConnected()) return;
    let active = true;
    setBalanceLoading(true);
    void new OceanGatewayClient().openRouterBalance().then((value) => {
      if (active) setOpenRouterBalance(value);
    }).catch(() => {
      if (active) setOpenRouterBalance(null);
    }).finally(() => {
      if (active) setBalanceLoading(false);
    });
    return () => { active = false; };
  }, [panel]);

  const togglePanel = (next: Exclude<ToolPanel, null>) => {
    if (next === "model") setModelField(null);
    setPanel((current) => current === next ? null : next);
  };

  const playMusicTrack = async (index: number) => {
    const selected = musicTracks[index];
    if (!selected) return;
    setTrack(index);
    setMusicNotice("正在接入歌曲…");
    try {
      const playback = await new OceanGatewayClient().musicPlayback(selected.id);
      if (!playback.playable || !playback.url) {
        setMusicNotice("这首歌受版权限制，请在网易云音乐里播放");
        return;
      }
      const player = audioPlayer.current;
      if (!player) return;
      player.src = playback.url;
      player.loop = playMode === "single";
      await player.play();
      setMusicNotice("");
    } catch {
      setMusicNotice("播放没有开始，再轻点一次当前歌曲试试");
    }
  };

  const advanceMusicTrack = () => {
    if (!musicTracks.length || playMode === "single") return;
    const next = playMode === "shuffle" && musicTracks.length > 1
      ? (track + 1 + Math.floor(Math.random() * (musicTracks.length - 1))) % musicTracks.length
      : (track + 1) % musicTracks.length;
    void playMusicTrack(next);
  };

  const nextMusicTrack = () => {
    if (!musicTracks.length) return;
    const next = playMode === "shuffle" && musicTracks.length > 1
      ? (track + 1 + Math.floor(Math.random() * (musicTracks.length - 1))) % musicTracks.length
      : (track + 1) % musicTracks.length;
    void playMusicTrack(next);
  };

  const toggleMusicPlayback = async () => {
    const player = audioPlayer.current;
    if (!player) return;
    if (!player.paused) {
      player.pause();
      return;
    }
    if (!player.src) {
      await playMusicTrack(track);
      return;
    }
    try {
      await player.play();
      setMusicNotice("");
    } catch {
      setMusicNotice("播放没有继续，请再轻点一次试试");
    }
  };

  const selectModel = (id: string) => {
    const next = models.find((item) => item.id === id);
    if (!next) return;
    setModel(next);
    setProfileId(next.profiles[0].id);
    setModelSettings(Object.fromEntries(next.settings.map((setting) => [setting.id, setting.defaultValue])));
  };

  useEffect(() => {
    if (!model.providerId) return;
    setModelSelection({ providerId: model.providerId, modelId: model.id, settings: modelSettings });
  }, [model, modelSettings]);

  const activeModelField = useMemo(() => {
    if (modelField === "model") return { label: "模型", items: models.map((item) => ({ id: item.id, label: compactModelName(item) })), value: model.id, onChange: selectModel };
    if (modelField === "profile") return { label: "运行变体", items: model.profiles, value: profileId, onChange: setProfileId };
    if (modelField?.startsWith("setting:")) {
      const setting = model.settings.find((item) => item.id === modelField.slice(8));
      if (setting) return { label: setting.label, items: setting.options, value: modelSettings[setting.id] ?? setting.defaultValue, onChange: (value: string) => setModelSettings((current) => ({ ...current, [setting.id]: value })) };
    }
    return null;
  }, [model, modelField, modelSettings, models, profileId]);

  const submit = () => {
    if (sendDisabled) return;
    setPanel(null);
    onSend(attachments);
    setAttachments([]);
  };

  const acceptFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const next = await Promise.all(Array.from(files).slice(0, 3).map(fileToAttachment));
      setAttachments((current) => [...current, ...next].slice(0, 3));
      setAttachmentNotice(next.length === 1 ? `已加入 ${next[0].name}` : `已加入 ${next.length} 个附件`);
    } catch (error) {
      setAttachmentNotice(error instanceof Error ? error.message : "附件读取失败");
    }
  };

  const runAttachmentAction = (id: string) => {
    if (onAttachmentAction) {
      onAttachmentAction(id);
      setPanel(null);
      return;
    }
    if (id === "camera") cameraInput.current?.click();
    else if (id === "picture") pictureInput.current?.click();
    else if (id === "file") fileInput.current?.click();
    else if (id === "connector") { setPanel("connectors"); return; }
    setPanel(null);
  };

  const addConnector = (id: string, provider: string) => {
    const connectorAttachment: ChatAttachment = {
      id: crypto.randomUUID(),
      kind: "connector",
      name: provider,
      mimeType: "application/x-ocean-connector",
      size: 0,
      data: id,
    };
    setAttachments((current) => [...current.filter((item) => item.kind !== "connector"), connectorAttachment].slice(0, 3));
    setAttachmentNotice(`已连接 ${provider} 的只读上下文`);
    setPanel(null);
  };

  return (
    <div className={`room-chat-chrome ${variant}-chat-chrome`}>
      {reasoning && (
        <button className="living-thinking" aria-label="展开可展示的思考摘要" onClick={() => setReasoningOpen(true)}>
          <span className="thinking-large" aria-hidden="true" />
          <span className="thinking-small" aria-hidden="true" />
        </button>
      )}

      <div className={`living-chat-tools ${panel === "music" || panel === "model" || panel === "usage" ? "tool-panel-open" : ""}`}>
        <button className="living-tool-button music" aria-label="音乐" onClick={() => togglePanel("music")}>
          <img className="tool-circle" src={livingAsset("tool-circle.svg")} alt="" />
          <img className="tool-icon music-icon" src={livingAsset("tool-music.svg")} alt="" />
        </button>
        <button
          aria-label={`模型：${displayedModelName}`}
          className="living-model-pill"
          onClick={() => onModelClick ? onModelClick() : togglePanel("model")}
          title={modelLabelOverride ?? model.name}
        ><span>{displayedModelName}</span></button>
        <button className="living-tool-button usage" aria-label="用量" onClick={() => togglePanel("usage")}>
          <img className="tool-circle" src={livingAsset("tool-circle.svg")} alt="" />
          <img className="tool-icon usage-icon" src={livingAsset("tool-usage.svg")} alt="" />
        </button>
      </div>

      {panel && <button className="living-popover-dismiss" aria-label="收起当前面板" onClick={() => setPanel(null)} />}

      {panel === "music" && (
        <section className="living-tool-popover music-panel" aria-label="音乐控制" onClick={(event) => event.stopPropagation()}>
          <div className="tool-panel-surface" />
          <button className="music-playlist-prev" disabled={musicPlaylists.length < 2} aria-label="上一个歌单" onClick={() => setPlaylist((value) => (value - 1 + musicPlaylists.length) % musicPlaylists.length)}><img src={livingAsset("music-prev.svg")} alt="" /></button>
          <MusicPlaylistTitle name={musicPlaylists[playlist]?.name ?? (musicConnection === "disconnected" ? "尚未连接" : "正在接入")} />
          <button className="music-playlist-next" disabled={musicPlaylists.length < 2} aria-label="下一个歌单" onClick={() => setPlaylist((value) => (value + 1) % musicPlaylists.length)}><img src={livingAsset("music-next.svg")} alt="" /></button>
          {musicConnection === "connected" && musicTracks.length
            ? <MusicWheel items={musicTracks} onActivate={(index) => void playMusicTrack(index)} onChange={(index) => { setTrack(index); void playMusicTrack(index); }} value={track} />
            : <div className="music-empty-state">{musicConnection === "disconnected" ? <>请先在设置里<br />连接网易云</> : musicConnection === "error" ? <>音乐服务暂时<br />没有接通</> : musicNotice || "正在读取歌单…"}</div>}
          <div className={`music-mode-actions ${musicConnection !== "connected" ? "disabled" : ""}`}>
            <button className={playMode === "single" ? "selected" : ""} disabled={musicConnection !== "connected"} aria-label="单曲循环" onClick={() => { setPlayMode("single"); if (audioPlayer.current) audioPlayer.current.loop = true; }}>
              <img className="music-action-bg" src={livingAsset("music-action-circle.svg")} alt="" />
              <img className="music-action-icon" src={livingAsset("music-repeat-one.svg")} alt="" />
            </button>
            <button className="music-transport-action" disabled={musicConnection !== "connected" || !musicTracks.length} aria-label={musicPlaying ? "暂停" : "继续播放"} onClick={() => void toggleMusicPlayback()}>
              <img className="music-action-bg" src={livingAsset("music-action-circle.svg")} alt="" />
              <img className="music-action-icon" src={livingAsset(musicPlaying ? "music-pause.svg" : "music-play.svg")} alt="" />
            </button>
            <button className={playMode === "list" ? "selected" : ""} disabled={musicConnection !== "connected"} aria-label="列表循环" onClick={() => { setPlayMode("list"); if (audioPlayer.current) audioPlayer.current.loop = false; }}>
              <img className="music-action-bg" src={livingAsset("music-action-circle.svg")} alt="" />
              <img className="music-action-icon" src={livingAsset("music-repeat.svg")} alt="" />
            </button>
            <button className="music-transport-action" disabled={musicConnection !== "connected" || !musicTracks.length} aria-label="下一首" onClick={nextMusicTrack}>
              <img className="music-action-bg" src={livingAsset("music-action-circle.svg")} alt="" />
              <img className="music-action-icon" src={livingAsset("music-next.svg")} alt="" />
            </button>
            <button className={playMode === "shuffle" ? "selected" : ""} disabled={musicConnection !== "connected"} aria-label="随机播放" onClick={() => { setPlayMode("shuffle"); if (audioPlayer.current) audioPlayer.current.loop = false; }}>
              <img className="music-action-bg" src={livingAsset("music-action-circle.svg")} alt="" />
              <img className="music-action-icon" src={livingAsset("music-shuffle.svg")} alt="" />
            </button>
          </div>
          {musicNotice && musicConnection === "connected" ? <div aria-live="polite" className="music-live-notice" title={musicNotice}>{musicNotice}</div> : null}
          <div className="music-panel-anchor" aria-hidden="true"><img className="anchor-bg" src={livingAsset("music-panel-anchor-circle.svg")} alt="" /><img className="anchor-icon" src={livingAsset("panel-music-anchor.svg")} alt="" /></div>
        </section>
      )}

      {panel === "model" && (
        <section className="living-tool-popover model-panel" aria-label="选择模型" onClick={(event) => event.stopPropagation()}>
          <div className="tool-panel-surface" />
          {activeModelField ? (
            <div className="model-field-editor">
              <div className="model-field-header">
                <button className="model-field-back" aria-label="返回模型参数" onClick={() => setModelField(null)}><svg aria-hidden="true" viewBox="0 0 12 12"><path d="M7.5 2.25 3.75 6l3.75 3.75" /></svg></button>
                <div className="model-field-title">{activeModelField.label}</div>
              </div>
              <div className="model-field-highlight" aria-hidden="true" />
              <div className="model-field-wheel"><WheelColumn ariaLabel={activeModelField.label} items={activeModelField.items} onChange={activeModelField.onChange} value={activeModelField.value} /></div>
            </div>
          ) : (
            <div className="model-config-list">
              <button onClick={() => setModelField("model")}><span>模型</span><b>{modelName}</b><i>›</i></button>
              <button onClick={() => setModelField("profile")}><span>运行变体</span><b>{model.profiles.find((item) => item.id === profileId)?.label}</b><i>›</i></button>
              {model.settings.map((setting) => <button key={setting.id} onClick={() => setModelField(`setting:${setting.id}`)}><span>{setting.label}</span><b>{setting.options.find((item) => item.id === (modelSettings[setting.id] ?? setting.defaultValue))?.label}</b><i>›</i></button>)}
            </div>
          )}
          <button aria-label={`使用 ${modelName} · ${model.profiles.find((item) => item.id === profileId)?.label ?? "Default"}`} className="model-panel-anchor" onClick={() => setPanel(null)}>{modelName}</button>
        </section>
      )}

      {panel === "usage" && (
        <section className="living-tool-popover usage-panel" aria-label="用量与余额" onClick={(event) => event.stopPropagation()}>
          <div className="tool-panel-surface" />
          <dl>
            <div><dt>本轮花费</dt><dd>{formatCost(usage.latest?.cost, latestCurrency, usage.latest?.costEstimated)}</dd></div>
            <div><dt>本日累计花费</dt><dd title={Object.entries(usage.dailyCosts).map(([currency, value]) => formatCost(value, currency, usage.estimatedCurrencies.includes(currency))).join(" / ")}>{formatCost(dailyCost, latestCurrency, latestCurrency ? usage.estimatedCurrencies.includes(latestCurrency) : false)}</dd></div>
            <div><dt>缓存复用</dt><dd title="本轮输入 token 中由提供方缓存直接复用的比例">{usage.latest ? formatCache(usage.latest.inputTokens, usage.latest.cachedTokens) : "—"}</dd></div>
            <div><dt>储存剩余</dt><dd>{storageRemainingPercent === undefined ? "待 Forge" : `${storageRemainingPercent}%`}</dd></div>
            <div><dt>OR 余额</dt><dd title={openRouterBalance ? `总充值 ${formatCost(openRouterBalance.totalCredits, "USD")} · 累计消耗 ${formatCost(openRouterBalance.totalUsage, "USD")}` : "OpenRouter 账户余额"}>{balanceLoading ? "读取中" : formatCost(openRouterBalance?.remaining, "USD")}</dd></div>
          </dl>
          <div className="usage-panel-anchor" aria-hidden="true"><img src={livingAsset("usage-anchor.svg")} alt="" /></div>
        </section>
      )}

      {panel === "attachments" && (
        <section className={`living-attachment-menu ${variant === "study" ? "study-project-gpt-menu" : ""}`} aria-label="更多输入选项" onClick={(event) => event.stopPropagation()}>
          {attachmentActions.map((action) => <button key={action.id} onClick={() => runAttachmentAction(action.id)}><img src={action.icon} alt="" />{action.label}</button>)}
          {onNightTalkChange && <button className={`night-talk-option ${nightTalk ? "enabled" : ""}`} onClick={() => onNightTalkChange(!nightTalk)}><img src={livingAsset("moon.svg")} alt="" />夜谈</button>}
        </section>
      )}

      {panel === "connectors" && (
        <section className="living-attachment-menu living-connector-menu" aria-label="选择连接器" onClick={(event) => event.stopPropagation()}>
          <strong>本轮只读上下文</strong>
          {connectors.filter((item) => item.configured && item.id !== "fishing").map((item) => <button key={item.id} onClick={() => addConnector(item.id, item.provider)}><img src={livingAsset("plus-connector.svg")} alt="" />{item.provider}</button>)}
          {!connectors.some((item) => item.configured && item.id !== "fishing") ? <small>暂未添加连接器</small> : null}
        </section>
      )}

      {attachments.length ? <div className="living-attachment-chips" aria-label="待发送附件">
        {attachments.map((item) => <button aria-label={`移除 ${item.name}`} key={item.id} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}>{item.kind === "connector" ? "⌁" : item.kind === "image" ? "▧" : "▤"}<span>{item.name}</span></button>)}
      </div> : null}
      {attachmentNotice ? <div aria-live="polite" className="living-attachment-notice">{attachmentNotice}</div> : null}

      <div className="living-composer">
        <button className="living-composer-more" aria-label="更多输入选项" onClick={() => togglePanel("attachments")}><img src={livingAsset("composer-plus.svg")} alt="" /></button>
        <textarea
          aria-label="输入消息"
          placeholder={nightTalk ? "夜谈氛围已开启…" : inputPlaceholder}
          rows={1}
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onCompositionEnd={(event) => onInputChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button aria-label="发送" className="living-send-button" disabled={sendDisabled} onClick={submit}><img src={livingAsset("composer-send.svg")} alt="" /></button>
      </div>

      <input accept="image/*" capture="environment" className="living-hidden-file" onChange={(event) => { void acceptFiles(event.target.files); event.target.value = ""; }} ref={cameraInput} type="file" />
      <input accept="image/*" className="living-hidden-file" multiple onChange={(event) => { void acceptFiles(event.target.files); event.target.value = ""; }} ref={pictureInput} type="file" />
      <input accept=".txt,.md,.markdown,.json,.csv,text/plain,text/markdown,application/json,text/csv" className="living-hidden-file" multiple onChange={(event) => { void acceptFiles(event.target.files); event.target.value = ""; }} ref={fileInput} type="file" />
      <audio className="living-hidden-audio" onEnded={advanceMusicTrack} onPause={() => setMusicPlaying(false)} onPlay={() => setMusicPlaying(true)} preload="none" ref={audioPlayer} />

      <OceanBottomSheet
        className="living-reasoning-sheet"
        contentLength={reasoning ? reasoning.title.length + reasoning.content.length : 0}
        label="可展示的思考摘要"
        onClose={() => setReasoningOpen(false)}
        open={reasoningOpen && Boolean(reasoning)}
      >
        {reasoning && <><h2>{reasoning.title}</h2><p>{reasoning.content}</p></>}
      </OceanBottomSheet>
    </div>
  );
}
