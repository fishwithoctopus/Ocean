import { CSSProperties, FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { usePersistentState } from "../hooks/usePersistentState";
import { gatewaySchedulerAdapter } from "../adapters/gatewayScheduler";
import type { FreeTimeConfig, FreeTimeRun } from "../domain/freeTime";
import { MiniSwitch } from "./MiniSwitch";
import { OceanBottomSheet } from "./OceanBottomSheet";
import { assetPath } from "../utils/assetPath";

type CanDoItem = {
  id?: string;
  label: string;
  enabled: boolean;
  connector?: string;
  description?: string;
};

type LeisureGame = {
  id: string;
  label: string;
  connector?: string;
  icon: "fishing" | "game";
};

type Controls = {
  silence: string;
  cooldown: string;
  activeHours: string;
  probability: string;
};

const INITIAL_CAN_DO: CanDoItem[] = [
  { id: "forum", label: "逛论坛", enabled: true, connector: "forum", description: "只读浏览，不发帖或互动" },
  { id: "reading", label: "看书", enabled: true },
  { id: "message", label: "给用户发消息", enabled: false },
];

const INITIAL_GAMES: LeisureGame[] = [];

const INITIAL_CONTROLS: Controls = {
  silence: "90分钟",
  cooldown: "240分钟",
  activeHours: "8:00–2:00",
  probability: "0.35",
};

const CAN_DO_PAGE_SIZE = 3;
const GAME_DRAG_STEP = 54;
const GAME_SETTLE_MS = 280;
const GAME_SLOTS = [-3, -2, -1, 0, 1, 2, 3] as const;

function numberFromControl(value: string, fallback: number) {
  const parsed = Number(value.match(/[\d.]+/)?.[0]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeClock(value: string, fallback: string) {
  const [hour, minute = "00"] = value.trim().split(":");
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (!Number.isInteger(parsedHour) || !Number.isInteger(parsedMinute) || parsedHour < 0 || parsedHour > 24 || parsedMinute < 0 || parsedMinute > 59) return fallback;
  return `${String(parsedHour).padStart(2, "0")}:${String(parsedMinute).padStart(2, "0")}`;
}

function activeHoursFromControl(value: string) {
  const [start = "08:00", end = "02:00"] = value.split(/[–—-]/);
  return { start: normalizeClock(start, "08:00"), end: normalizeClock(end, "02:00") };
}

function wrappedIndex(index: number, length: number) {
  return (index % length + length) % length;
}

function coverFlowCenter(distance: number) {
  const stops = [0, 28, 48, 60];
  const clamped = Math.min(3, Math.abs(distance));
  const lower = Math.floor(clamped);
  const upper = Math.ceil(clamped);
  const interpolated = stops[lower] + (stops[upper] - stops[lower]) * (clamped - lower);
  return 195 + Math.sign(distance) * interpolated;
}

function coverFlowStyle(position: number) {
  const depth = Math.min(3, Math.abs(position));
  const size = 120 - depth * 8;
  const center = coverFlowCenter(position);
  const contentOpacity = Math.max(0, 1 - depth * 1.12);
  const layer = depth < .55 ? "var(--surface)" : depth < 1.5 ? "var(--accent-soft)" : depth < 2.5 ? "var(--accent)" : "var(--ink)";
  return {
    "--card-content-opacity": contentOpacity,
    "--card-depth": depth,
    background: layer,
    boxShadow: depth < .55
      ? "0 7px 14px rgb(89 96 138 / 16%), inset 0 1px 0 rgb(255 255 255 / 82%)"
      : depth < 1.5
        ? "0 3px 7px rgb(89 96 138 / 10%)"
        : "0 1px 3px rgb(89 96 138 / 8%)",
    height: `${size}px`,
    left: `${center - size / 2}px`,
    top: `${depth * 4}px`,
    width: `${size}px`,
    zIndex: Math.max(1, 10 - Math.round(depth * 2)),
    transform: `perspective(360px) rotateY(${Math.max(-7, Math.min(7, position * -5))}deg) translateZ(${(3 - depth) * 2}px)`,
  } as CSSProperties;
}

function localDayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function activityDate(run: FreeTimeRun) {
  return new Date(run.completedAt ?? run.createdAt);
}

function activityTime(run: FreeTimeRun) {
  return activityDate(run).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function activityPreview(run: FreeTimeRun) {
  return run.summary?.trim() || "完成了一次自由活动";
}

function recordOpacity(index: number, total: number) {
  if (index === total - 1) return 1;
  if (total === 3 && index === 0) return .4;
  return .6;
}

function AddIcon() {
  return <img alt="" aria-hidden="true" src={assetPath("assets/leisure/add.svg")} />;
}

export function LeisureRoom() {
  const [paused, setPaused] = usePersistentState("ocean:free-time:paused", false);
  const [canDo, setCanDo] = usePersistentState<CanDoItem[]>("ocean:free-time:can-do", INITIAL_CAN_DO);
  const [controls, setControls] = usePersistentState<Controls>("ocean:free-time:controls:v3", INITIAL_CONTROLS);
  const [games, setGames] = usePersistentState<LeisureGame[]>("ocean:free-time:games:v3", INITIAL_GAMES);
  const [canDoPage, setCanDoPage] = useState(0);
  const [gameIndex, setGameIndex] = useState(0);
  const [editing, setEditing] = useState<"can-do" | "game" | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [canDoDraft, setCanDoDraft] = useState({ label: "", connector: "", description: "" });
  const [gameDraft, setGameDraft] = useState({ label: "", connector: "" });
  const [gameDragX, setGameDragX] = useState(0);
  const [gameDragging, setGameDragging] = useState(false);
  const [gameSettling, setGameSettling] = useState(false);
  const [schedulerState, setSchedulerState] = useState<"syncing" | "synced" | "offline">("syncing");
  const [triggerState, setTriggerState] = useState<"idle" | "running" | "success" | "error">("idle");
  const [automaticDispatch, setAutomaticDispatch] = useState<boolean | null>(null);
  const [recentRuns, setRecentRuns] = useState<FreeTimeRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<FreeTimeRun | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const gameGesture = useRef<{ pointerId: number; startX: number; lastX: number; lastAt: number; velocity: number; distance: number } | null>(null);
  const gameSettleTimer = useRef<number | null>(null);

  useEffect(() => {
    const migrationKey = "ocean:free-time:forum-mcp-migrated:v1";
    if (window.localStorage.getItem(migrationKey)) return;
    setCanDo((current) => current.some((item) => item.id === "forum" || item.connector === "forum")
      ? current
      : [INITIAL_CAN_DO[0], ...current]);
    window.localStorage.setItem(migrationKey, "true");
  }, [setCanDo]);

  const canDoPageCount = Math.max(1, Math.ceil((canDo.length + 1) / CAN_DO_PAGE_SIZE));
  const visibleCanDo = useMemo(() => {
    const start = canDoPage * CAN_DO_PAGE_SIZE;
    return Array.from({ length: CAN_DO_PAGE_SIZE }, (_, offset) => canDo[start + offset] ?? null);
  }, [canDo, canDoPage]);
  const currentGame = games[Math.min(gameIndex, Math.max(0, games.length - 1))];
  const visibleGameSlots = games.length === 0 ? [] : games.length < 2 ? [0] : GAME_SLOTS;
  const schedulerConfig = useMemo<FreeTimeConfig>(() => ({
    paused,
    minSilenceMinutes: numberFromControl(controls.silence, 45),
    cooldownMinutes: numberFromControl(controls.cooldown, 60),
    activeHours: activeHoursFromControl(controls.activeHours),
    probability: Math.min(1, Math.max(0, numberFromControl(controls.probability, 0.7))),
    canDo,
    games,
  }), [paused, controls, canDo, games]);
  const todayKey = localDayKey(clock);
  const todayActions = useMemo(() => recentRuns
    .filter((run) => run.status === "completed" && run.summary && localDayKey(activityDate(run)) === todayKey)
    .sort((left, right) => activityDate(right).getTime() - activityDate(left).getTime())
    .slice(0, 3)
    .reverse(), [recentRuns, todayKey]);
  const latestAffect = [...todayActions].reverse().find((run) => typeof run.valence === "number" || typeof run.arousal === "number");

  useEffect(() => {
    setSchedulerState("syncing");
    const timer = window.setTimeout(() => {
      void gatewaySchedulerAdapter.updateConfig(schedulerConfig)
        .then(() => setSchedulerState("synced"))
        .catch(() => setSchedulerState("offline"));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [schedulerConfig]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      setClock(new Date());
      void Promise.allSettled([
        gatewaySchedulerAdapter.listRuns(),
        gatewaySchedulerAdapter.getCapabilities(),
      ]).then(([runs, capabilities]) => {
        if (!active) return;
        setRecentRuns(runs.status === "fulfilled" ? runs.value : []);
        setAutomaticDispatch(capabilities.status === "fulfilled"
          ? capabilities.value.scheduler?.automaticDispatch ?? null
          : null);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => () => {
    if (gameSettleTimer.current !== null) window.clearTimeout(gameSettleTimer.current);
  }, []);

  const closeEditor = () => setEditing(null);
  const triggerFreeTimeNow = async () => {
    if (triggerState === "running") return;
    setTriggerState("running");
    try {
      await gatewaySchedulerAdapter.updateConfig(schedulerConfig);
      await gatewaySchedulerAdapter.triggerNow();
      setRecentRuns(await gatewaySchedulerAdapter.listRuns());
      setClock(new Date());
      setTriggerState("success");
      window.setTimeout(() => setTriggerState("idle"), 2200);
    } catch {
      setTriggerState("error");
      window.setTimeout(() => setTriggerState("idle"), 3200);
    }
  };
  const changeCanDoPage = (next: number) => setCanDoPage(Math.max(0, Math.min(next, canDoPageCount - 1)));
  const handleCanDoPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (dragStart === null) return;
    const distance = event.clientX - dragStart;
    if (Math.abs(distance) > 28) changeCanDoPage(canDoPage + (distance < 0 ? 1 : -1));
    setDragStart(null);
  };

  const settleGame = (direction: "next" | "previous" | null) => {
    if (gameSettleTimer.current !== null) window.clearTimeout(gameSettleTimer.current);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = direction === "next" ? -GAME_DRAG_STEP : direction === "previous" ? GAME_DRAG_STEP : 0;
    setGameDragging(false);
    setGameSettling(!reducedMotion);
    setGameDragX(target);
    const finish = () => {
      if (direction) setGameIndex((index) => wrappedIndex(index + (direction === "next" ? 1 : -1), games.length));
      setGameSettling(false);
      setGameDragX(0);
    };
    if (reducedMotion) finish();
    else gameSettleTimer.current = window.setTimeout(finish, GAME_SETTLE_MS);
  };

  const showGame = (direction: "next" | "previous") => {
    if (games.length < 2 || gameDragging || gameSettling) return;
    settleGame(direction);
  };

  const beginGameDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (games.length < 2 || gameSettling || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gameGesture.current = { pointerId: event.pointerId, startX: event.clientX, lastX: event.clientX, lastAt: event.timeStamp, velocity: 0, distance: 0 };
    setGameDragging(true);
  };

  const moveGameDrag = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gameGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const elapsed = Math.max(1, event.timeStamp - gesture.lastAt);
    const instantaneousVelocity = (event.clientX - gesture.lastX) / elapsed;
    gesture.velocity = gesture.velocity * .55 + instantaneousVelocity * .45;
    gesture.lastX = event.clientX;
    gesture.lastAt = event.timeStamp;
    const distance = Math.max(-GAME_DRAG_STEP * 1.15, Math.min(GAME_DRAG_STEP * 1.15, event.clientX - gesture.startX));
    gesture.distance = distance;
    setGameDragX(distance);
  };

  const endGameDrag = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gameGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gameGesture.current = null;
    const projected = gesture.distance + gesture.velocity * 90;
    if (projected <= -GAME_DRAG_STEP * .34) settleGame("next");
    else if (projected >= GAME_DRAG_STEP * .34) settleGame("previous");
    else settleGame(null);
  };

  const cancelGameDrag = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gameGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gameGesture.current = null;
    settleGame(null);
  };

  const saveCanDo = (event: FormEvent) => {
    event.preventDefault();
    const label = canDoDraft.label.trim();
    if (!label) return;
    setCanDo((items) => [...items, {
      id: `can-do-${Date.now()}`,
      label,
      enabled: true,
      connector: canDoDraft.connector.trim() || undefined,
      description: canDoDraft.description.trim() || undefined,
    }]);
    setCanDoDraft({ label: "", connector: "", description: "" });
    closeEditor();
  };

  const saveGame = (event: FormEvent) => {
    event.preventDefault();
    const label = gameDraft.label.trim();
    if (!label) return;
    const nextGame: LeisureGame = {
      id: `game-${Date.now()}`,
      label,
      connector: gameDraft.connector.trim() || undefined,
      icon: "game",
    };
    setGames((items) => [...items, nextGame]);
    setGameIndex(games.length);
    setGameDraft({ label: "", connector: "" });
    closeEditor();
  };

  return (
    <section className="leisure-room-fidelity" aria-label="休闲：自由时间">
      {editing && <button aria-label="取消本次编辑" className="leisure-edit-dismiss" onClick={closeEditor} />}

      <article className="leisure-activity-card" aria-label="最近自由行动">
        <div className="leisure-activity-inner">
          <div className="leisure-activity-copy">
            <h2><time dateTime={todayKey}>{clock.getFullYear()}.{clock.getMonth() + 1}.{clock.getDate()}</time></h2>
            <div className="leisure-activity-records">
              {todayActions.length ? todayActions.map((run, index) => (
                <button
                  aria-label={`${activityTime(run)}，${activityPreview(run)}，点按查看完整记录`}
                  className="leisure-activity-record"
                  key={run.id}
                  onClick={() => setSelectedRun(run)}
                  style={{ "--record-opacity": recordOpacity(index, todayActions.length) } as CSSProperties}
                  type="button"
                >
                  <time>{activityTime(run)}</time><span>{activityPreview(run)}</span>
                </button>
              )) : <p className="leisure-activity-empty">今天还没有自由行动记录</p>}
            </div>
            <span className="leisure-activity-affect" aria-label={latestAffect ? `情绪效价 ${latestAffect.valence ?? "未记录"}，唤醒度 ${latestAffect.arousal ?? "未记录"}` : "最近一次自由行动还没有情绪记录"} title="V：情绪效价；A：唤醒度">V {latestAffect?.valence?.toFixed(2) ?? "—"}&nbsp;&nbsp; A {latestAffect?.arousal?.toFixed(2) ?? "—"}</span>
          </div>
          <div className="leisure-activity-mascot" aria-hidden="true">
            <img src={assetPath("assets/leisure/activity-mascot.png")} alt="" />
          </div>
        </div>
      </article>

      {editing === "can-do" ? (
        <form className="leisure-inline-editor leisure-cando-editor" onClick={(event) => event.stopPropagation()} onSubmit={saveCanDo}>
          <label className="leisure-editor-row activity-row">
            <img alt="" src={assetPath("assets/leisure/leisure-form-chain.svg")} />
            <input autoFocus aria-label="活动" placeholder="活动" value={canDoDraft.label} onChange={(event) => setCanDoDraft({ ...canDoDraft, label: event.target.value })} />
          </label>
          <label className="leisure-editor-row connector-row">
            <img alt="" src={assetPath("assets/leisure/leisure-form-connector.svg")} />
            <input aria-label="连接器（如有）" placeholder="连接器（如有）" value={canDoDraft.connector} onChange={(event) => setCanDoDraft({ ...canDoDraft, connector: event.target.value })} />
          </label>
          <label className="leisure-editor-row description-row">
            <img alt="" src={assetPath("assets/leisure/leisure-form-description.svg")} />
            <input aria-label="简要描述" placeholder="简要描述" value={canDoDraft.description} onChange={(event) => setCanDoDraft({ ...canDoDraft, description: event.target.value })} />
          </label>
          <button className="leisure-editor-save" aria-label="添加 Can Do" type="submit"><AddIcon /></button>
        </form>
      ) : (
        <section
          className="leisure-cando-card"
          aria-label={`Can Do，第 ${canDoPage + 1} 页，共 ${canDoPageCount} 页`}
          onPointerDown={(event) => setDragStart(event.clientX)}
          onPointerLeave={() => setDragStart(null)}
          onPointerUp={handleCanDoPointerUp}
        >
          <h2>Can Do</h2>
          <div className="leisure-cando-rows">
            {visibleCanDo.map((item, slot) => {
              const absoluteIndex = canDoPage * CAN_DO_PAGE_SIZE + slot;
              if (item) return (
                <div className="leisure-cando-row" key={item.id ?? `${item.label}-${absoluteIndex}`}>
                  <span>{item.label}</span>
                  <MiniSwitch
                    className="leisure-cando-switch"
                    disabledLabel={`停用${item.label}`}
                    enabledLabel={`启用${item.label}`}
                    onChange={() => setCanDo((items) => items.map((entry, index) => index === absoluteIndex ? { ...entry, enabled: !entry.enabled } : entry))}
                    selected={item.enabled}
                  />
                </div>
              );
              if (absoluteIndex === canDo.length) return (
                <button className="leisure-cando-row leisure-cando-add" key="add-can-do" onClick={() => setEditing("can-do")} type="button">
                  <AddIcon /><span className="sr-only">增加 Can Do</span>
                </button>
              );
              return <span aria-hidden="true" className="leisure-cando-row empty" key={`empty-${slot}`} />;
            })}
          </div>
          <div className="leisure-pager" aria-label="Can Do 页面">
            {Array.from({ length: canDoPageCount }, (_, index) => (
              <button aria-label={`第 ${index + 1} 页`} className={index === canDoPage ? "current" : ""} key={index} onClick={() => changeCanDoPage(index)} type="button" />
            ))}
          </div>
        </section>
      )}

      <section className={`leisure-time-card ${paused ? "paused" : ""}`} aria-label="自由活动时间控制" data-scheduler-state={schedulerState} title={schedulerState === "synced" ? "已同步至 Ocean Gateway" : schedulerState === "offline" ? "Gateway 未连接，当前保存在本机" : "正在同步"}>
        <h2>Time Control</h2>
        <button className="leisure-pause" aria-label={paused ? "恢复自由时间" : "暂停自由时间"} onClick={() => setPaused((value) => !value)} title={paused ? "恢复自由时间" : "暂停自由时间"} type="button">{paused ? "▶" : "Ⅱ"}</button>
        {([
          ["静默时间", "silence"],
          ["冷却时间", "cooldown"],
          ["活跃区间", "activeHours"],
          ["可能性", "probability"],
        ] as const).map(([label, key]) => (
          <label className="leisure-time-row" key={key}>
            <span>{label}</span>
            <input aria-label={label} value={controls[key]} onChange={(event) => setControls({ ...controls, [key]: event.target.value })} />
          </label>
        ))}
        <button
          aria-live="polite"
          className={`leisure-trigger ${triggerState} ${automaticDispatch === false ? "automatic-disabled" : ""}`}
          disabled={triggerState === "running"}
          onClick={() => void triggerFreeTimeNow()}
          title="忽略静默、冷却与概率限制，立即运行一次自由时间"
          type="button"
        >
          {triggerState === "running" ? "正在活动…" : triggerState === "success" ? "已完成" : triggerState === "error" ? "触发失败" : automaticDispatch === false ? "手动触发 · 自动未开" : "立即触发"}
        </button>
      </section>

      <section className="leisure-games" aria-label="小游戏">
        <div
          aria-label={currentGame ? `当前游戏：${currentGame.label}` : "游戏库为空，等待添加游戏"}
          aria-live="polite"
          className={`leisure-game-stack ${gameDragging ? "dragging" : ""} ${gameSettling ? "settling" : ""}`}
          onPointerCancel={cancelGameDrag}
          onPointerDown={beginGameDrag}
          onPointerMove={moveGameDrag}
          onPointerUp={endGameDrag}
        >
          {visibleGameSlots.map((slot) => {
            const position = slot + gameDragX / GAME_DRAG_STEP;
            const game = games[wrappedIndex(gameIndex + slot, games.length)];
            const focused = Math.abs(position) < .5;
            return (
              <article aria-hidden={!focused} className="leisure-game-card" key={`${slot}-${game.id}`} style={coverFlowStyle(position)}>
                <img alt="" src={assetPath(game.icon === "fishing" ? "assets/leisure/fishing.svg" : "assets/leisure/leisure-game-icon.svg")} />
                <strong>{game.label}</strong>
              </article>
            );
          })}
          {!currentGame ? (
            <article className="leisure-game-card leisure-game-empty" aria-live="polite">
              <img alt="" src={assetPath("assets/leisure/leisure-game-icon.svg")} />
              <strong>等待添加游戏</strong>
            </article>
          ) : null}
        </div>
        <button className="leisure-game-arrow previous" aria-label="上一个游戏" disabled={games.length < 2} onClick={() => showGame("previous")} type="button"><span aria-hidden="true" className="leisure-game-arrow-shape" /></button>
        <button className="leisure-game-arrow next" aria-label="下一个游戏" disabled={games.length < 2} onClick={() => showGame("next")} type="button"><span aria-hidden="true" className="leisure-game-arrow-shape" /></button>
        {editing !== "game" ? <button className="leisure-game-add" aria-label="增加游戏" onClick={() => setEditing("game")} type="button"><AddIcon /></button> : null}
      </section>

      {editing === "game" ? (
        <form className="leisure-inline-editor leisure-game-editor" onClick={(event) => event.stopPropagation()} onSubmit={saveGame}>
          <label className="leisure-editor-row game-name-row">
            <img alt="" src={assetPath("assets/leisure/leisure-game-icon.svg")} />
            <input autoFocus aria-label="游戏" placeholder="游戏" value={gameDraft.label} onChange={(event) => setGameDraft({ ...gameDraft, label: event.target.value })} />
          </label>
          <label className="leisure-editor-row game-connector-row">
            <img alt="" src={assetPath("assets/leisure/leisure-game-link.svg")} />
            <input aria-label="连接器" placeholder="连接器" value={gameDraft.connector} onChange={(event) => setGameDraft({ ...gameDraft, connector: event.target.value })} />
          </label>
          <button className="leisure-editor-save game-save" aria-label="添加游戏" type="submit"><AddIcon /></button>
        </form>
      ) : null}

      <div className="leisure-free-time" aria-hidden="true">
        <span className="free-word" />
        <span className="time-word" />
        <img className="decor-left" src={assetPath("assets/leisure/decor-left.svg")} alt="" />
        <span className="decor-octopus" />
        <span className="decor-fish" />
        <span className="decor-right" />
        <i className="free-time-line" />
      </div>

      <OceanBottomSheet
        contentLength={selectedRun?.summary?.length ?? 0}
        detent="auto"
        label="自由活动记录"
        onClose={() => setSelectedRun(null)}
        open={Boolean(selectedRun)}
      >
        {selectedRun ? <article className="leisure-activity-detail">
          <header>
            <div>
              <h2>自由活动记录</h2>
              <time dateTime={selectedRun.completedAt ?? selectedRun.createdAt}>
                {activityDate(selectedRun).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
              </time>
            </div>
            <span title="V：情绪效价；A：唤醒度">V {selectedRun.valence?.toFixed(2) ?? "—"}&nbsp;&nbsp; A {selectedRun.arousal?.toFixed(2) ?? "—"}</span>
          </header>
          <p>{selectedRun.summary}</p>
        </article> : null}
      </OceanBottomSheet>
    </section>
  );
}
