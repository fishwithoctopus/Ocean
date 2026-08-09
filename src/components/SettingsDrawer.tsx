import { useEffect, useState } from "react";
import { OceanGatewayClient, type OceanNotionStatus } from "../api/OceanGatewayClient";
import type { ProviderSummary } from "../domain/ocean";
import type { MusicQrLogin, MusicQrState, MusicStatus } from "../domain/music";
import { getGatewayBaseUrl, setGatewayBaseUrl } from "../config/gateway";
import { setModelSelection } from "../config/modelSelection";
import { clearLocalOceanData, downloadOceanData, importOceanData } from "../data/portableData";
import { usePersistentState } from "../hooks/usePersistentState";
import { DEFAULT_RELATIONSHIP_SETTINGS, type RelationshipSettings } from "../stores/useHomeStore";
import { restoreFromGateway } from "../sync/gatewayRestore";
import { flushOutbox } from "../sync/gatewaySync";
import {
  disableOceanNotifications,
  enableOceanNotifications,
  getOceanNotificationStatus,
  syncOceanNotificationPreferences,
  testOceanNotification,
  type NotificationPreferences,
  type OceanNotificationStatus,
} from "../notifications";

type ConnectionSection = "model" | "gateway" | "memory" | "reading" | "forum" | "notion" | "music" | "notifications";
type Section = ConnectionSection | "relationship" | "data";
type ConnectionState = "mock" | "connected" | "staging" | "disconnected";

const labels: Record<Section, string> = {
  model: "模型",
  gateway: "网关",
  memory: "Ocean Memory",
  reading: "共读 MCP",
  forum: "Forum MCP",
  notion: "Notion",
  music: "网易云音乐",
  notifications: "通知",
  relationship: "开始日",
  data: "数据与隐私",
};

function daysSince(startDate: string) {
  const start = new Date(`${startDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(start.getTime())) return 0;
  return Math.max(0, Math.floor((today.getTime() - start.getTime()) / 86_400_000) + 1);
}

function OceanSelect({ ariaLabel, defaultValue, options, onChange }: { ariaLabel: string; defaultValue: string; options: string[]; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  useEffect(() => setValue(defaultValue), [defaultValue]);
  return (
    <div className="ocean-select" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button aria-expanded={open} aria-haspopup="listbox" aria-label={ariaLabel} className="ocean-select-trigger" onClick={() => setOpen((current) => !current)} type="button">
        <span>{value}</span><i aria-hidden="true" />
      </button>
      {open ? (
        <div aria-label={`${ariaLabel}选项`} className="ocean-select-menu" role="listbox">
          {options.map((option) => (
            <button aria-selected={option === value} className={option === value ? "selected" : ""} key={option} onClick={() => { setValue(option); onChange?.(option); setOpen(false); }} role="option" type="button">{option}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const pad2 = (value: number) => String(value).padStart(2, "0");

function OceanDatePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const initial = new Date(`${value || DEFAULT_RELATIONSHIP_SETTINGS.startDate}T00:00:00`);
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth());
  const selected = new Date(`${value || DEFAULT_RELATIONSHIP_SETTINGS.startDate}T00:00:00`);
  const firstOffset = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7;
  const monthLength = new Date(viewYear, viewMonth + 1, 0).getDate();
  const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

  const moveMonth = (offset: number) => {
    const next = new Date(viewYear, viewMonth + offset, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const selectDay = (day: number) => {
    onChange(`${viewYear}-${pad2(viewMonth + 1)}-${pad2(day)}`);
    setOpen(false);
  };

  return (
    <div className="ocean-date-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button aria-expanded={open} aria-haspopup="dialog" aria-label="开始日期" className="ocean-date-trigger" onClick={() => setOpen((current) => !current)} type="button">
        <span>{value || "选择日期"}</span><i aria-hidden="true" />
      </button>
      {open ? (
        <div aria-label="选择开始日期" className="ocean-calendar-popover" role="dialog">
          <div className="ocean-calendar-head">
            <button aria-label="上个月" onClick={() => moveMonth(-1)} type="button">‹</button>
            <strong>{viewYear}年 {viewMonth + 1}月</strong>
            <button aria-label="下个月" onClick={() => moveMonth(1)} type="button">›</button>
          </div>
          <div className="ocean-calendar-weekdays">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
          <div className="ocean-calendar-days">
            {Array.from({ length: firstOffset }, (_, index) => <span key={`blank-${index}`} />)}
            {Array.from({ length: monthLength }, (_, index) => index + 1).map((day) => {
              const isSelected = selected.getFullYear() === viewYear && selected.getMonth() === viewMonth && selected.getDate() === day;
              return <button aria-label={`${viewYear}年${viewMonth + 1}月${day}日`} className={isSelected ? "selected" : ""} key={day} onClick={() => selectDay(day)} type="button">{day}</button>;
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<Section>("model");
  const [states, setStates] = usePersistentState<Record<ConnectionSection, ConnectionState>>("ocean:connections", {
    model: "mock",
    gateway: "mock",
    memory: "mock",
    reading: "mock",
    forum: "disconnected",
    notion: "disconnected",
    music: "disconnected",
    notifications: "disconnected",
  });
  const [relationship, setRelationship] = usePersistentState<RelationshipSettings>("ocean:relationship-settings", DEFAULT_RELATIONSHIP_SETTINGS);
  const [relationshipDraft, setRelationshipDraft] = useState(relationship);
  const [notice, setNotice] = useState("");
  const [gatewayUrl, setGatewayUrlDraft] = useState(getGatewayBaseUrl);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [providerId, setProviderId] = useState("mock");
  const [notificationStatus, setNotificationStatus] = useState<OceanNotificationStatus>("available");
  const [musicStatus, setMusicStatus] = useState<MusicStatus | null>(null);
  const [musicQr, setMusicQr] = useState<MusicQrLogin | null>(null);
  const [musicQrState, setMusicQrState] = useState<MusicQrState["state"] | null>(null);
  const [notionStatus, setNotionStatus] = useState<OceanNotionStatus | null>(null);
  const [notificationPreferences, setNotificationPreferences] = usePersistentState<NotificationPreferences>("ocean:notification-preferences:v1", {
    paperNotes: true,
    freeTime: true,
    showPreview: false,
    quietStart: "02:00",
    quietEnd: "08:00",
  });

  const loadProviders = async () => {
    const available = await new OceanGatewayClient().listProviders();
    setProviders(available);
    const current = available.find((provider) => provider.id === providerId);
    if (!current) setProviderId(available.find((provider) => provider.configured && provider.id !== "mock")?.id ?? available[0]?.id ?? "mock");
    window.dispatchEvent(new Event("ocean:providers-changed"));
    return available;
  };

  useEffect(() => {
    if (states.gateway !== "connected") return;
    void loadProviders().catch(() => undefined);
  }, [states.gateway]);

  useEffect(() => {
    if (section !== "notifications") return;
    void getOceanNotificationStatus().then((status) => {
      setNotificationStatus(status);
      setStates((current) => ({ ...current, notifications: status === "subscribed" ? "connected" : "disconnected" }));
    });
  }, [section, setStates]);

  useEffect(() => {
    if (section !== "music") return;
    void new OceanGatewayClient().musicStatus().then((status) => {
      setMusicStatus(status);
      setStates((current) => ({ ...current, music: status.connected ? "connected" : "disconnected" }));
    }).catch(() => {
      setMusicStatus(null);
      setStates((current) => ({ ...current, music: "disconnected" }));
    });
  }, [section, setStates]);

  useEffect(() => {
    if (section !== "notion") return;
    void new OceanGatewayClient().notionStatus().then((status) => {
      setNotionStatus(status);
      setStates((current) => ({ ...current, notion: status.connected ? "connected" : "disconnected" }));
    }).catch(() => {
      setNotionStatus(null);
      setStates((current) => ({ ...current, notion: "disconnected" }));
    });
  }, [section, setStates]);

  useEffect(() => {
    if (section !== "music" || !musicQr || musicQrState === "authorized" || musicQrState === "expired") return;
    let active = true;
    let timer = 0;
    const check = async () => {
      try {
        const result = await new OceanGatewayClient().checkMusicQr(musicQr.key);
        if (!active) return;
        setMusicQrState(result.state);
        if (result.state === "authorized") {
          const status = result.status ?? await new OceanGatewayClient().musicStatus(true);
          if (!active) return;
          setMusicStatus(status);
          setStates((current) => ({ ...current, music: status.connected ? "connected" : "disconnected" }));
          setNotice(status.connected ? `网易云已连接 · ${status.profile?.nickname ?? "扫码用户"}` : "网易云授权没有完成，请重新扫码");
          setMusicQr(null);
          window.dispatchEvent(new Event("ocean:music-changed"));
        } else if (result.state === "confirming") setNotice("已扫码，请在网易云音乐里确认登录");
        else if (result.state === "expired") setNotice("二维码已经过期，请重新生成");
      } catch {
        if (active) setNotice("网易云登录状态暂时无法读取");
      }
    };
    void check();
    timer = window.setInterval(() => void check(), 1800);
    return () => { active = false; window.clearInterval(timer); };
  }, [musicQr, musicQrState, section, setStates]);

  const updateNotificationPreferences = (update: Partial<NotificationPreferences>) => {
    const next = { ...notificationPreferences, ...update };
    setNotificationPreferences(next);
    if (notificationStatus === "subscribed") void syncOceanNotificationPreferences(next).catch(() => setNotice("通知偏好暂时未能同步"));
  };

  const enableNotifications = async () => {
    setNotice("正在向这台设备申请通知权限…");
    try {
      const status = await enableOceanNotifications(notificationPreferences);
      setNotificationStatus(status);
      if (status === "subscribed") {
        setStates((current) => ({ ...current, notifications: "connected" }));
        setNotice("通知已经启用，可以发送一条测试通知");
      } else if (status === "needs-install") setNotice("请先用 Safari 的“添加到主屏幕”安装 Ocean，再从桌面图标打开并启用通知");
      else if (status === "denied") setNotice("系统已拒绝通知；请在 iPhone 设置的 Ocean 通知权限中重新允许");
      else if (status === "unsupported") setNotice("当前浏览器或系统不支持 PWA 通知");
      else setNotice("尚未允许通知，请再次点击启用");
    } catch (error) {
      setNotice(error instanceof Error ? `通知连接失败：${error.message}` : "通知连接失败");
    }
  };

  const disableNotifications = async () => {
    await disableOceanNotifications();
    setNotificationStatus("available");
    setStates((current) => ({ ...current, notifications: "disconnected" }));
    setNotice("这台设备的 Ocean 通知已经关闭");
  };

  const sendTestNotification = async () => {
    setNotice("正在发送测试通知…");
    try {
      const result = await testOceanNotification();
      setNotice(result.sent ? "测试通知已经发出，请看手机通知中心" : "当前没有可送达的设备");
    } catch {
      setNotice("测试通知未能送达；可以关闭后重新启用一次通知");
    }
  };

  const statusFor = (key: Section) => {
    if (key === "relationship") return relationship.startDate ? "已设置" : "未设置";
    if (key === "data") return "本机";
    return states[key] === "connected" ? "已连接" : states[key] === "staging" ? "仅暂存" : "未连接";
  };

  const connectGateway = async () => {
    setNotice("正在检查网关…");
    try {
      setGatewayBaseUrl(gatewayUrl);
      const health = await new OceanGatewayClient().health();
      await loadProviders();
      const restored = await restoreFromGateway();
      setStates((current) => ({ ...current, gateway: "connected" }));
      const result = await flushOutbox(true);
      setNotice(`网关 ${health.version} 已连接 · 恢复 ${restored.conversations} 个会话 · 同步 ${result.sent} 项${result.remaining ? `，${result.remaining} 项待重试` : ""}`);
    } catch {
      setStates((current) => ({ ...current, gateway: "disconnected" }));
      setNotice("网关暂时无法连接");
    }
  };

  const connectReading = async () => {
    setNotice("正在寻找共读书房…");
    try {
      const health = await new OceanGatewayClient().readingHealth();
      setStates((current) => ({ ...current, reading: "connected" }));
      setNotice(`共读 MCP 已连接 · 找到 ${health.books} 本书`);
    } catch {
      setStates((current) => ({ ...current, reading: "disconnected" }));
      setNotice("共读服务暂时无法连接，共读页会保留离线演示书页");
    }
  };

  const connectForum = async () => {
    setNotice("正在检查陪伴者的 Forum 只读连接…");
    try {
      const health = await new OceanGatewayClient().forumHealth();
      setStates((current) => ({ ...current, forum: "connected" }));
      setNotice(`Forum MCP 已连接 · ${health.name} ${health.version} · 只读模式`);
    } catch {
      setStates((current) => ({ ...current, forum: "disconnected" }));
      setNotice("Forum MCP 暂时无法连接；Ocean 不会把未执行的论坛浏览记成真实行动");
    }
  };

  const startMusicLogin = async () => {
    setNotice("正在生成网易云登录二维码…");
    try {
      const qr = await new OceanGatewayClient().createMusicQr();
      setMusicQr(qr);
      setMusicQrState("waiting");
      setNotice("请用网易云音乐 App 扫码并确认");
    } catch {
      setNotice("暂时无法生成网易云二维码，请稍后再试");
    }
  };

  const disconnectMusic = async () => {
    await new OceanGatewayClient().disconnectMusic().catch(() => undefined);
    setMusicStatus({ available: true, connected: false, provider: "netease-cloud-music" });
    setMusicQr(null);
    setMusicQrState(null);
    setStates((current) => ({ ...current, music: "disconnected" }));
    window.dispatchEvent(new Event("ocean:music-changed"));
    setNotice("这台 Ocean 已经退出网易云音乐");
  };

  const connectMemory = async () => {
    setNotice("正在检查 Memory 数据路径…");
    try {
      const health = await new OceanGatewayClient().memoryHealth();
      setStates((current) => ({ ...current, memory: "connected" }));
      setNotice(`Memory 3.0 已连接 · ${health.provider} · ${health.tools.length} 个工具`);
    } catch {
      const manifest = await new OceanGatewayClient().integrations().catch(() => null);
      const staged = manifest?.services.find((service) => service.id === "memory")?.state === "staging";
      setStates((current) => ({ ...current, memory: staged ? "staging" : "disconnected" }));
      setNotice(staged ? "当前只能把记忆候选暂存在 Gateway，尚未写入 Memory 3.0" : "无法读取记忆集成状态，请先连接 Ocean Gateway");
    }
  };

  const connectNotion = async () => {
    setNotice("正在检查 Notion 项目镜像…");
    try {
      const status = await new OceanGatewayClient().testNotion();
      setNotionStatus(status);
      setStates((current) => ({ ...current, notion: status.connected ? "connected" : "disconnected" }));
      setNotice(status.connected ? `Notion 已连接${status.parentTitle ? ` · ${status.parentTitle}` : ""}` : "Notion 尚未连接");
    } catch (error) {
      setStates((current) => ({ ...current, notion: "disconnected" }));
      setNotice(error instanceof Error ? `Notion 连接失败：${error.message}` : "Notion 连接失败");
    }
  };

  const connectProvider = async () => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) { setNotice("请先连接 Ocean Gateway"); return; }
    setNotice(`正在测试 ${provider.name}…`);
    try {
      const result = await new OceanGatewayClient().testProvider(provider.id);
      const modelId = provider.defaultModel ? `${provider.id}:${provider.defaultModel}` : "";
      if (provider.id !== "mock" && modelId) {
        setModelSelection({ providerId: provider.id, modelId, settings: {} });
        window.localStorage.setItem("ocean:chat:live", "true");
      }
      setStates((current) => ({ ...current, model: "connected" }));
      window.dispatchEvent(new Event("ocean:providers-changed"));
      setNotice(`${provider.name} 已连接 · ${result.detail}`);
    } catch (error) {
      setStates((current) => ({ ...current, model: "disconnected" }));
      setNotice(error instanceof Error ? error.message : `${provider.name} 暂时无法连接`);
    }
  };

  const exportData = () => {
    const count = downloadOceanData();
    setNotice(`已导出 ${count} 组 Ocean 本机数据；密钥不会进入备份`);
  };

  const importData = async (file?: File) => {
    if (!file || !window.confirm("导入会覆盖备份中同名的本机数据，继续吗？")) return;
    try {
      const count = await importOceanData(file);
      setNotice(`已导入 ${count} 组数据，正在重新载入 Ocean`);
      window.setTimeout(() => window.location.reload(), 500);
    } catch {
      setNotice("无法识别这个 Ocean 备份文件");
    }
  };

  const clearData = async () => {
    if (!window.confirm("删除这台设备上的 Ocean 演示数据？服务器与独立记忆库不会被删除。")) return;
    const count = await clearLocalOceanData();
    setNotice(`已删除 ${count} 组本机数据，正在重新载入 Ocean`);
    window.setTimeout(() => window.location.reload(), 500);
  };

  const saveRelationship = () => {
    const next = {
      startLabel: relationshipDraft.startLabel.trim() || DEFAULT_RELATIONSHIP_SETTINGS.startLabel,
      startDate: relationshipDraft.startDate,
    };
    setRelationship(next);
    setRelationshipDraft(next);
    setNotice("开始日已经保存，首页天数会自动更新");
  };

  return (
    <aside className="drawer settings-drawer expanded" aria-label="设置" onClick={(event) => event.stopPropagation()}>
      <div className="drawer-header"><h2>设置</h2><button aria-label="关闭设置" className="plain-button" onClick={onClose}>×</button></div>
      <nav className="settings-nav">
        {(Object.keys(labels) as Section[]).map((key) => (
          <button className={section === key ? "selected" : ""} key={key} onClick={() => { setSection(key); setNotice(""); }}>
            <span>{labels[key]}</span><small>{statusFor(key)}</small>
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {section === "model" && <><h3>模型提供方</h3><p>密钥只保存在 Ocean Gateway；前端读取提供方、模型与能力，不保存密钥。</p><label>提供方<OceanSelect ariaLabel="提供方" defaultValue={providers.find((provider) => provider.id === providerId)?.name ?? "Ocean Mock"} options={(providers.length ? providers : [{ id: "mock", name: "Ocean Mock" }]).map((provider) => provider.name)} onChange={(name) => setProviderId(providers.find((provider) => provider.name === name)?.id ?? "mock")} /></label><label>连接状态<input value={providers.find((provider) => provider.id === providerId)?.configured ? "Gateway 已配置" : "等待在 Gateway 配置"} readOnly /></label><label>默认模型<input value={providers.find((provider) => provider.id === providerId)?.defaultModel ?? "未设置"} readOnly /></label><label>API Key<input value="由 Ocean Gateway 安全管理" readOnly /></label><button className="primary-setting" onClick={() => void connectProvider()}>测试模型连接</button></>}
        {section === "gateway" && <><h3>Ocean 网关</h3><p>负责密钥、流式事件、Usage、缓存和会话续接。</p><label>部署方式<OceanSelect ariaLabel="部署方式" defaultValue="用户自托管" options={["用户自托管", "Ocean Cloud（路线图）"]} /></label><label>Gateway URL<input value={gatewayUrl} onChange={(event) => setGatewayUrlDraft(event.target.value)} /></label><label>健康检查<input defaultValue="/health" readOnly /></label><button className="primary-setting" onClick={() => void connectGateway()}>保存并测试网关</button></>}
        {section === "memory" && <><h3>Ocean Memory 3.0</h3><p>长期记忆由独立记忆库持有，Ocean 只通过服务端适配器读写；Gateway 暂存不等于已经进入记忆库。</p><label>服务地址<input defaultValue="由 Ocean Gateway 私有配置" readOnly /></label><label>当前写入路径<input value={states.memory === "connected" ? "Memory 3.0" : states.memory === "staging" ? "Gateway 候选暂存" : "等待检测"} readOnly /></label><label>访问凭据<input defaultValue="由服务端管理" readOnly /></label><button className="primary-setting" onClick={() => void connectMemory()}>检查 Memory 路径</button></>}
        {section === "reading" && <><h3>共读书房</h3><p>Ocean Gateway 通过 REST 连接 co-reading-mcp；模型仍可使用同一服务的 MCP 工具。</p><label>连接方式<OceanSelect ariaLabel="共读连接方式" defaultValue="经 Ocean Gateway" options={["经 Ocean Gateway", "离线演示"]} /></label><label>服务地址<input defaultValue="http://127.0.0.1:8788" readOnly /></label><label>上下文策略<input defaultValue="每章节每会话一次" readOnly /></label><button className="primary-setting" onClick={() => void connectReading()}>测试共读连接</button></>}
        {section === "forum" && <><h3>Forum MCP</h3><p>陪伴者账号由 Ocean Gateway 私有持有。当前只允许真实浏览论坛；不会自动发帖、回复、点赞、收藏或修改资料。</p><label>账号<input value="陪伴者专用账号" readOnly /></label><label>自动行动权限<input value="只读浏览" readOnly /></label><label>访问凭据<input value="只保存在 Ocean Gateway" readOnly /></label><button className="primary-setting" onClick={() => void connectForum()}>测试 Forum 连接</button></>}
        {section === "notion" && <><h3>Notion 项目镜像</h3><p>Ocean Server 始终保存主数据；Notion 只镜像项目说明、文档标题、正文和文件清单。当前为单向同步，不会把 Notion 手动编辑反向覆盖 Ocean。</p><label>授权方式<input value="服务端内部集成" readOnly /></label><label>目标页面<input value={notionStatus?.parentTitle ?? (notionStatus?.parentPageConfigured ? "已配置，等待检测" : "尚未配置")} readOnly /></label><label>同步方式<input value={notionStatus?.autoSync ? "保存后自动同步＋手动同步" : "项目空间内手动同步"} readOnly /></label><label>访问凭据<input value="只保存在 Ocean Gateway" readOnly /></label><button className="primary-setting" onClick={() => void connectNotion()}>测试 Notion 连接</button></>}
        {section === "music" && <><h3>网易云音乐</h3><p>使用二维码授权个人歌单。登录 Cookie 只保存在 Ocean Gateway，不进入浏览器、导出文件或开源版本。</p>{musicStatus?.connected ? <><div className="music-account-card">{musicStatus.profile?.avatarUrl ? <img alt="" src={musicStatus.profile.avatarUrl} /> : <span aria-hidden="true" />}<div><small>已连接</small><strong>{musicStatus.profile?.nickname ?? "网易云用户"}</strong></div></div><button className="secondary-setting" onClick={() => void disconnectMusic()}>退出网易云音乐</button></> : musicQr ? <><div className="music-qr-card"><img alt="网易云音乐登录二维码" src={musicQr.qrImage} /><strong>{musicQrState === "confirming" ? "请在网易云确认" : musicQrState === "expired" ? "二维码已过期" : "请用网易云音乐扫码"}</strong><small>建议在电脑打开此页，再用手机网易云扫码</small></div><button className="secondary-setting" onClick={() => void startMusicLogin()}>重新生成二维码</button></> : <button className="primary-setting" onClick={() => void startMusicLogin()}>连接网易云音乐</button>}</>}
        {section === "notifications" && <><h3>通知</h3><p>安装到主屏幕后，纸条与自由活动可以通过 Web Push 到达手机。未开启内容预览时，锁屏只显示隐私安全的提示。</p><label className="toggle-setting"><span>纸条通知</span><input checked={notificationPreferences.paperNotes} onChange={(event) => updateNotificationPreferences({ paperNotes: event.target.checked })} type="checkbox" /></label><label className="toggle-setting"><span>自由活动通知</span><input checked={notificationPreferences.freeTime} onChange={(event) => updateNotificationPreferences({ freeTime: event.target.checked })} type="checkbox" /></label><label className="toggle-setting"><span>显示通知内容</span><input checked={notificationPreferences.showPreview} onChange={(event) => updateNotificationPreferences({ showPreview: event.target.checked })} type="checkbox" /></label><label><span>静默开始</span><input onChange={(event) => updateNotificationPreferences({ quietStart: event.target.value })} type="time" value={notificationPreferences.quietStart} /></label><label><span>静默结束</span><input onChange={(event) => updateNotificationPreferences({ quietEnd: event.target.value })} type="time" value={notificationPreferences.quietEnd} /></label>{notificationStatus === "subscribed" ? <><button className="primary-setting" onClick={() => void sendTestNotification()}>发送测试通知</button><button className="secondary-setting" onClick={() => void disableNotifications()}>关闭这台设备的通知</button></> : <button className="primary-setting" onClick={() => void enableNotifications()}>启用这台设备的通知</button>}</>}
        {section === "relationship" && <><h3>共同生活</h3><p>用于首页最下方的开始日名称和相伴天数；天数按自然日自动计算。</p><label>开始日名称<input value={relationshipDraft.startLabel} onChange={(event) => setRelationshipDraft((current) => ({ ...current, startLabel: event.target.value }))} /></label><label>开始日期<OceanDatePicker value={relationshipDraft.startDate} onChange={(startDate) => setRelationshipDraft((current) => ({ ...current, startDate }))} /></label><div className="relationship-preview"><span>{relationshipDraft.startLabel || DEFAULT_RELATIONSHIP_SETTINGS.startLabel}</span><strong>{daysSince(relationshipDraft.startDate)} Days</strong></div><button className="primary-setting" disabled={!relationshipDraft.startDate} onClick={saveRelationship}>保存开始日</button></>}
        {section === "data" && <><h3>数据与隐私</h3><p>聊天时间线与长期记忆分开保存；所有内容都应可导出与删除。</p><div className="data-location"><span>聊天与项目</span><strong>Ocean Server</strong></div><div className="data-location"><span>长期记忆</span><strong>Memory 3.0</strong></div><div className="data-location"><span>当前演示</span><strong>浏览器本地</strong></div><button className="secondary-setting" onClick={exportData}>导出 Ocean 数据</button><label className="secondary-setting import-setting">导入 Ocean 数据<input hidden type="file" accept="application/json,.json" onChange={(event) => void importData(event.target.files?.[0])} /></label><button className="danger-setting" onClick={() => void clearData()}>删除本机演示数据</button></>}
      </div>
      {notice && <div className="settings-notice">{notice}</div>}
    </aside>
  );
}
