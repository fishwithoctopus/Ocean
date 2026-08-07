import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CountdownEvent } from "../stores/useHomeStore";
import { useHomeStore } from "../stores/useHomeStore";
import { MiniSwitch } from "./MiniSwitch";
import { OceanIcon, type OceanIconName } from "./OceanIcon";
import { OceanBottomSheet } from "./OceanBottomSheet";
import { OceanGatewayClient } from "../api/OceanGatewayClient";
import { assetPath } from "../utils/assetPath";

const impressions = [3, 0, 1, 1, 1, 3, 0, 0, 0, 0, 0, 3, 0, 3, 1, 1, 1, 3, 1, 0, 0, 0, 3, 1, 3, 1, 1, 0, 0, 0, 1];
const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const wheelOffsets = [-2, -1, 0, 1, 2];
const WHEEL_ITEM_HEIGHT = 14;
const WHEEL_VIEWPORT_HEIGHT = 72;
const WHEEL_EDGE_PADDING = (WHEEL_VIEWPORT_HEIGHT - WHEEL_ITEM_HEIGHT) / 2;
const WHEEL_VIRTUAL_CYCLES = 200;
const WHEEL_OVERSCAN = 8;

const pad2 = (value: number) => String(value).padStart(2, "0");
const wrapIndex = (index: number, length: number) => ((index % length) + length) % length;
const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();
const compactNumeralSpacing = (value: string) => value.replace(/(\d)\s+(?=[\p{L}])/gu, "$1");

function countdownIconFor(title: string): OceanIconName | null {
  const normalized = title.toLowerCase();
  if (/(生日|生辰|birthday)/i.test(normalized)) return "birthday";
  if (/(毕业|graduate|graduation)/i.test(normalized)) return "graduate";
  if (/(见面|纪念|周年|爱|meet|anniversary)/i.test(normalized)) return "heart";
  return null;
}

function WheelColumn({
  values,
  value,
  suffix,
  onChange,
}: {
  values: number[];
  value: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const selectedIndex = Math.max(0, values.indexOf(value));
  const middleCycle = Math.floor(WHEEL_VIRTUAL_CYCLES / 2);
  const initialVirtualIndex = middleCycle * values.length + selectedIndex;
  const totalVirtualItems = Math.max(1, values.length * WHEEL_VIRTUAL_CYCLES);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const virtualIndexRef = useRef(initialVirtualIndex);
  const previousLengthRef = useRef(values.length);
  const settleTimerRef = useRef<number | null>(null);
  const [virtualIndex, setVirtualIndex] = useState(initialVirtualIndex);

  const setRenderedVirtualIndex = (nextIndex: number) => {
    const bounded = Math.max(0, Math.min(totalVirtualItems - 1, nextIndex));
    virtualIndexRef.current = bounded;
    setVirtualIndex((current) => current === bounded ? current : bounded);
    return bounded;
  };

  const commitVirtualIndex = (nextIndex: number) => {
    const bounded = setRenderedVirtualIndex(nextIndex);
    const nextValue = values[wrapIndex(bounded, values.length)];
    if (nextValue !== value) onChange(nextValue);

    const edgeGuard = values.length * 10;
    if (bounded < edgeGuard || bounded > totalVirtualItems - edgeGuard) {
      const recentered = middleCycle * values.length + wrapIndex(bounded, values.length);
      virtualIndexRef.current = recentered;
      setVirtualIndex(recentered);
      if (viewportRef.current) viewportRef.current.scrollTop = recentered * WHEEL_ITEM_HEIGHT;
    }
  };

  const scrollToVirtualIndex = (nextIndex: number, behavior: ScrollBehavior = "smooth") => {
    const bounded = setRenderedVirtualIndex(nextIndex);
    const resolvedBehavior = behavior === "smooth" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : behavior;
    viewportRef.current?.scrollTo({ top: bounded * WHEEL_ITEM_HEIGHT, behavior: resolvedBehavior });
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => commitVirtualIndex(bounded), resolvedBehavior === "smooth" ? 180 : 0);
  };

  useLayoutEffect(() => {
    const current = virtualIndexRef.current;
    const lengthChanged = previousLengthRef.current !== values.length;
    const currentValueIndex = wrapIndex(current, values.length);
    let nextIndex = middleCycle * values.length + selectedIndex;

    if (!lengthChanged) {
      const forward = wrapIndex(selectedIndex - currentValueIndex, values.length);
      const backward = forward - values.length;
      nextIndex = current + (Math.abs(forward) <= Math.abs(backward) ? forward : backward);
    }

    previousLengthRef.current = values.length;
    const bounded = setRenderedVirtualIndex(nextIndex);
    if (viewportRef.current) viewportRef.current.scrollTop = bounded * WHEEL_ITEM_HEIGHT;
  }, [selectedIndex, values.length]);

  useEffect(() => () => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
  }, []);

  const virtualStart = Math.max(0, virtualIndex - WHEEL_OVERSCAN);
  const virtualEnd = Math.min(totalVirtualItems - 1, virtualIndex + WHEEL_OVERSCAN);
  const virtualSnapPoints = Array.from(
    { length: virtualEnd - virtualStart + 1 },
    (_, index) => virtualStart + index,
  );

  return (
    <div className="wheel-column">
      <div
        aria-label={`${suffix ?? "数值"}滚轮`}
        aria-valuemax={Math.max(...values)}
        aria-valuemin={Math.min(...values)}
        aria-valuenow={values[wrapIndex(virtualIndex, values.length)]}
        aria-valuetext={`${pad2(values[wrapIndex(virtualIndex, values.length)])}${suffix ?? ""}`}
        className="wheel-scroll-viewport"
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const localY = event.clientY - bounds.top;
          if (localY < bounds.height / 3) scrollToVirtualIndex(virtualIndexRef.current - 1);
          else if (localY > bounds.height * 2 / 3) scrollToVirtualIndex(virtualIndexRef.current + 1);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            scrollToVirtualIndex(virtualIndexRef.current - 1);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            scrollToVirtualIndex(virtualIndexRef.current + 1);
          }
        }}
        onScroll={(event) => {
          const nextIndex = Math.round(event.currentTarget.scrollTop / WHEEL_ITEM_HEIGHT);
          const bounded = setRenderedVirtualIndex(nextIndex);
          if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
          settleTimerRef.current = window.setTimeout(() => commitVirtualIndex(bounded), 140);
        }}
        ref={viewportRef}
        role="spinbutton"
        tabIndex={0}
      >
        <div
          aria-hidden="true"
          className="wheel-scroll-track"
          style={{ height: WHEEL_EDGE_PADDING * 2 + totalVirtualItems * WHEEL_ITEM_HEIGHT }}
        >
          {virtualSnapPoints.map((virtualItemIndex) => (
            <span
              className="wheel-snap-point"
              key={virtualItemIndex}
              style={{ top: WHEEL_EDGE_PADDING + virtualItemIndex * WHEEL_ITEM_HEIGHT }}
            />
          ))}
        </div>
      </div>
      <div aria-hidden="true" className="wheel-display">
        {wheelOffsets.map((offset) => {
          const item = values[wrapIndex(virtualIndex + offset, values.length)];
          return (
            <span className={`wheel-value wheel-offset-${Math.abs(offset)}`} key={`${offset}-${item}`}>
              <span className="wheel-number">{pad2(item)}</span>
              {offset === 0 && suffix ? <em>{suffix}</em> : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function nextCountdownTarget(countdown: CountdownEvent, reference = new Date()) {
  if (!countdown.targetDate) return null;
  const [storedYear, month, day] = countdown.targetDate.split("-").map(Number);
  if (!storedYear || !month || !day) return null;
  const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const safeDate = (year: number) => new Date(year, month - 1, Math.min(day, daysInMonth(year, month)));
  const storedTarget = safeDate(storedYear);
  if (storedTarget.getTime() >= today.getTime()) return storedTarget;
  let recurringTarget = safeDate(today.getFullYear());
  if (recurringTarget.getTime() < today.getTime()) recurringTarget = safeDate(today.getFullYear() + 1);
  return recurringTarget;
}

function remainingDays(countdown: CountdownEvent) {
  if (!countdown.targetDate) return countdown.days;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = nextCountdownTarget(countdown, today);
  if (!target) return countdown.days;
  return Math.max(0, Math.ceil((target.getTime() - today.getTime()) / 86_400_000));
}

export function HomeScreen() {
  const home = useHomeStore();
  const now = useMemo(() => new Date(), []);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentDay = now.getDate();
  const monthLength = daysInMonth(currentYear, currentMonth);
  const firstWeekdayOffset = (new Date(currentYear, currentMonth - 1, 1).getDay() + 6) % 7;
  const elapsedPercent = Math.round(((currentDay - 1) / monthLength) * 100);

  const [selectedDay, setSelectedDay] = useState(currentDay);
  const [memoryImpressions, setMemoryImpressions] = useState<Record<number, number>>({});
  const [countdownIndex, setCountdownIndex] = useState(0);
  const [todoPage, setTodoPage] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const [editor, setEditor] = useState<"todo" | "countdown" | null>(null);
  const [editingCountdownId, setEditingCountdownId] = useState<string | null>(null);
  const [countdownMenu, setCountdownMenu] = useState<CountdownEvent | null>(null);
  const countdownHoldTimer = useRef<number | null>(null);
  const countdownInputRef = useRef<HTMLInputElement | null>(null);
  const todoSwipeStart = useRef<number | null>(null);
  const todoDidSwipe = useRef(false);

  const [countdownTitle, setCountdownTitle] = useState("");
  const [targetYear, setTargetYear] = useState(currentYear);
  const [targetMonth, setTargetMonth] = useState(currentMonth);
  const [targetDay, setTargetDay] = useState(Math.min(currentDay, monthLength));

  const [todoTitle, setTodoTitle] = useState("");
  const [todoHasTime, setTodoHasTime] = useState(true);
  const [todoHasDate, setTodoHasDate] = useState(false);
  const [todoWheelMode, setTodoWheelMode] = useState<"time" | "date" | null>("time");
  const [todoHour, setTodoHour] = useState(now.getHours());
  const [todoMinute, setTodoMinute] = useState(now.getMinutes());
  const [todoMonth, setTodoMonth] = useState(currentMonth);
  const [todoDay, setTodoDay] = useState(currentDay);

  useLayoutEffect(() => {
    if (editor !== "countdown") return;
    countdownInputRef.current?.focus({ preventScroll: true });
  }, [editor]);

  const calendarCells = [
    ...Array.from({ length: firstWeekdayOffset }, () => null),
    ...Array.from({ length: monthLength }, (_, index) => index + 1),
  ];

  useEffect(() => {
    const controller = new AbortController();
    const from = `${currentYear}-${pad2(currentMonth)}-01`;
    const to = `${currentYear}-${pad2(currentMonth)}-${pad2(monthLength)}`;
    void new OceanGatewayClient().listDailyImpressions(from, to, controller.signal).then((items) => {
      setMemoryImpressions(Object.fromEntries(items.map((item) => [Number(item.date.slice(-2)), item.intensity])));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [currentMonth, currentYear, monthLength]);

  const impressionIntensity = (day: number) => memoryImpressions[day] ?? (Object.keys(memoryImpressions).length ? 0 : impressions[day - 1] ?? 0);

  const countdownEntries: Array<CountdownEvent | { id: "countdown-add" }> = [
    ...home.countdowns,
    { id: "countdown-add" },
  ];
  const countdownPageCount = Math.max(1, Math.ceil(countdownEntries.length / 3));
  const visibleCountdowns = countdownEntries.slice(countdownIndex * 3, countdownIndex * 3 + 3);
  const todoPages = Array.from(
    { length: Math.floor(home.todos.length / 3) + 1 },
    (_, index) => home.todos.slice(index * 3, index * 3 + 3),
  );
  const targetMonthLength = daysInMonth(targetYear, targetMonth);
  const todoMonthLength = daysInMonth(currentYear, todoMonth);
  const currentNoteId = now.getHours() >= 5 && now.getHours() < 12
    ? "morning"
    : now.getHours() < 17
      ? "noon"
      : now.getHours() < 22
        ? "evening"
        : "night";
  const currentNote = home.notes.find((note) => note.slot === currentNoteId || note.id === currentNoteId) ?? home.notes.at(-1);
  const sheetHost = typeof document === "undefined" ? null : document.querySelector(".ocean-shell");

  const changeTargetMonth = (month: number) => {
    setTargetMonth(month);
    setTargetDay((day) => Math.min(day, daysInMonth(targetYear, month)));
  };

  const changeTargetYear = (year: number) => {
    setTargetYear(year);
    setTargetDay((day) => Math.min(day, daysInMonth(year, targetMonth)));
  };

  const saveCountdown = () => {
    const title = countdownTitle.trim();
    if (!title) return;
    const targetDate = `${targetYear}-${pad2(targetMonth)}-${pad2(Math.min(targetDay, targetMonthLength))}`;
    const newItemPage = editingCountdownId
      ? Math.max(0, Math.floor(home.countdowns.findIndex((item) => item.id === editingCountdownId) / 3))
      : Math.floor(home.countdowns.length / 3);
    if (editingCountdownId) home.updateCountdown(editingCountdownId, title, targetDate);
    else home.addCountdown(title, targetDate);
    setCountdownIndex(newItemPage);
    setCountdownTitle("");
    setEditingCountdownId(null);
    setEditor(null);
  };

  const openCountdownEditor = (countdown?: CountdownEvent) => {
    setCountdownMenu(null);
    setEditingCountdownId(countdown?.id ?? null);
    setCountdownTitle(countdown?.title ?? "");
    if (countdown?.targetDate) {
      const nextTarget = nextCountdownTarget(countdown);
      if (nextTarget) {
        setTargetYear(nextTarget.getFullYear());
        setTargetMonth(nextTarget.getMonth() + 1);
        setTargetDay(nextTarget.getDate());
      }
    } else if (countdown) {
      const inferredTarget = new Date();
      inferredTarget.setHours(12, 0, 0, 0);
      inferredTarget.setDate(inferredTarget.getDate() + remainingDays(countdown));
      setTargetYear(inferredTarget.getFullYear());
      setTargetMonth(inferredTarget.getMonth() + 1);
      setTargetDay(inferredTarget.getDate());
    } else {
      setTargetYear(currentYear);
      setTargetMonth(currentMonth);
      setTargetDay(currentDay);
    }
    setEditor("countdown");
  };

  const clearCountdownHold = () => {
    if (countdownHoldTimer.current !== null) window.clearTimeout(countdownHoldTimer.current);
    countdownHoldTimer.current = null;
  };

  const saveTodo = () => {
    const title = todoTitle.trim();
    if (!title) return;
    const time = todoHasTime ? `${pad2(todoHour)}:${pad2(todoMinute)}` : "";
    const date = todoHasDate ? `${todoMonth}月${Math.min(todoDay, todoMonthLength)}日` : "";
    const newItemPage = Math.floor(home.todos.length / 3);
    home.addTodo(title, time, date);
    setTodoPage(newItemPage);
    setTodoTitle("");
    setEditor(null);
  };

  const toggleTodoSchedule = (mode: "time" | "date") => {
    if (mode === "time") {
      const next = !todoHasTime;
      setTodoHasTime(next);
      if (next) setTodoWheelMode("time");
      else if (todoWheelMode === "time") setTodoWheelMode(todoHasDate ? "date" : null);
      return;
    }
    const next = !todoHasDate;
    setTodoHasDate(next);
    if (next) setTodoWheelMode("date");
    else if (todoWheelMode === "date") setTodoWheelMode(todoHasTime ? "time" : null);
  };

  const moveTodoPage = (direction: -1 | 1) => {
    setTodoPage((current) => Math.min(todoPages.length - 1, Math.max(0, current + direction)));
  };

  const handleTodoPointerUp = (clientX: number) => {
    if (todoSwipeStart.current === null) return;
    const distance = clientX - todoSwipeStart.current;
    todoSwipeStart.current = null;
    if (Math.abs(distance) < 32 || todoPages.length < 2) return;
    todoDidSwipe.current = true;
    moveTodoPage(distance < 0 ? 1 : -1);
  };

  return (
    <section className="home-screen home-screen-fidelity" aria-label="首页：家">
      {editor ? <button className="inline-editor-dismiss" aria-label="取消本次编辑" onClick={() => { setEditor(null); setEditingCountdownId(null); }} type="button" /> : null}
      <div className="home-wordmark" aria-label="Ocean">
        <img src={assetPath("assets/ocean-wordmark.svg")} alt="Ocean" />
      </div>

      <section className="calendar-card card" aria-label={`${currentYear}年${currentMonth}月日印象日历`}>
        <div className="calendar-month-track" />
        <div className="calendar-month">{monthLabels[currentMonth - 1]}</div>
        <span className="calendar-percent">{elapsedPercent}%</span>
        <div className="weekday-row">
          {weekdayLabels.map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className={`calendar-days ${calendarCells.length > 35 ? "six-weeks" : ""}`}>
          {calendarCells.map((day, index) => day === null ? (
            <span className="calendar-blank" key={`blank-${index}`} />
          ) : (
            <button
              aria-label={`${currentMonth}月${day}日，日印象浓度${impressionIntensity(day)}`}
              className={`day intensity-${impressionIntensity(day)} ${day > currentDay ? "future" : ""} ${selectedDay === day ? "selected" : ""}`}
              key={day}
              onClick={() => setSelectedDay(day)}
            >
              <span>{day}</span>
            </button>
          ))}
        </div>
      </section>

      {editor === "countdown" ? (
        <section className="countdown-editor card inline-editor-active" aria-label="增加日期倒数">
          <select
            aria-label="年份"
            className="countdown-year"
            value={targetYear}
            onChange={(event) => changeTargetYear(Number(event.target.value))}
          >
            {Array.from({ length: 8 }, (_, index) => currentYear + index).map((year) => (
              <option key={year} value={year}>{year}年</option>
            ))}
          </select>
          <div className="date-wheel wheel-surface">
            <WheelColumn values={Array.from({ length: 12 }, (_, index) => index + 1)} value={targetMonth} suffix="月" onChange={changeTargetMonth} />
            <WheelColumn values={Array.from({ length: targetMonthLength }, (_, index) => index + 1)} value={Math.min(targetDay, targetMonthLength)} suffix="日" onChange={setTargetDay} />
          </div>
          <input
            aria-label="事件名称"
            autoFocus
            className="inline-card-input countdown-title-input"
            ref={countdownInputRef}
            value={countdownTitle}
            onChange={(event) => setCountdownTitle(event.target.value)}
          />
          <button className="editor-add-button" aria-label="添加日期倒数" onClick={saveCountdown} type="button"><span className="figma-add-icon" aria-hidden="true" /></button>
        </section>
      ) : (
        <section className="countdown-stack" aria-label="重要日期倒数">
          {visibleCountdowns.map((countdown) => !("title" in countdown) ? (
            <button className="countdown-add-card card" key={countdown.id} onClick={() => openCountdownEditor()} type="button">
              <span className="figma-add-icon" aria-hidden="true" />
            </button>
          ) : (
            <button
              aria-label={`${countdown.title}，长按可编辑或删除`}
              className={`countdown-card card ${countdownIconFor(countdown.title) ? "with-icon" : "without-icon"}`}
              key={countdown.id}
              onContextMenu={(event) => { event.preventDefault(); setCountdownMenu(countdown); }}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCountdownMenu(countdown); } }}
              onPointerCancel={clearCountdownHold}
              onPointerDown={() => {
                clearCountdownHold();
                countdownHoldTimer.current = window.setTimeout(() => setCountdownMenu(countdown), 520);
              }}
              onPointerLeave={clearCountdownHold}
              onPointerUp={clearCountdownHold}
              type="button"
            >
              <div>
                <p>{countdown.title}</p>
                <strong>{remainingDays(countdown)} <small>Days</small></strong>
              </div>
              {countdownIconFor(countdown.title) ? <OceanIcon className="countdown-icon" name={countdownIconFor(countdown.title) as OceanIconName} /> : null}
            </button>
          ))}
        </section>
      )}
      {editor !== "countdown" && countdownPageCount > 1 ? (
        <button
          className="next-countdown"
          onClick={() => setCountdownIndex((current) => (current + 1) % countdownPageCount)}
          aria-label="查看下一组倒数卡片"
        >
          <OceanIcon name="next" />
        </button>
      ) : null}

      {editor === "todo" ? (
        <section className="todo-editor card inline-editor-active" aria-label="增加待办">
          <input
            aria-label="待办事件"
            autoFocus
            className="inline-card-input todo-title-input"
            value={todoTitle}
            onChange={(event) => setTodoTitle(event.target.value)}
          />
          <div className="todo-schedule-modes">
            <div className={`schedule-control ${todoHasTime ? "selected" : ""} ${todoWheelMode === "time" ? "active" : ""}`}>
              <button aria-label="编辑待办时间" className="schedule-mode-button" onClick={() => { if (!todoHasTime) setTodoHasTime(true); setTodoWheelMode("time"); }} type="button"><span className="clock-glyph" aria-hidden="true" /></button>
              <MiniSwitch selected={todoHasTime} enabledLabel="包含时间" disabledLabel="不包含时间" onChange={() => toggleTodoSchedule("time")} />
            </div>
            <div className={`schedule-control ${todoHasDate ? "selected" : ""} ${todoWheelMode === "date" ? "active" : ""}`}>
              <button aria-label="编辑待办日期" className="schedule-mode-button" onClick={() => { if (!todoHasDate) setTodoHasDate(true); setTodoWheelMode("date"); }} type="button"><span className="calendar-glyph" aria-hidden="true" /></button>
              <MiniSwitch selected={todoHasDate} enabledLabel="包含日期" disabledLabel="不包含日期" onChange={() => toggleTodoSchedule("date")} />
            </div>
          </div>
          {todoWheelMode ? (
            <div className="todo-wheel wheel-surface" key={todoWheelMode}>
              {todoWheelMode === "time" ? (
                <>
                  <WheelColumn values={Array.from({ length: 24 }, (_, index) => index)} value={todoHour} suffix="时" onChange={setTodoHour} />
                  <WheelColumn values={Array.from({ length: 60 }, (_, index) => index)} value={todoMinute} suffix="分" onChange={setTodoMinute} />
                </>
              ) : (
                <>
                  <WheelColumn values={Array.from({ length: 12 }, (_, index) => index + 1)} value={todoMonth} suffix="月" onChange={(month) => { setTodoMonth(month); setTodoDay((day) => Math.min(day, daysInMonth(currentYear, month))); }} />
                  <WheelColumn values={Array.from({ length: todoMonthLength }, (_, index) => index + 1)} value={Math.min(todoDay, todoMonthLength)} suffix="日" onChange={setTodoDay} />
                </>
              )}
            </div>
          ) : <div className="todo-wheel-empty" />}
          <button className="editor-add-button todo-editor-add" aria-label="添加待办" onClick={saveTodo} type="button"><span className="figma-add-icon" aria-hidden="true" /></button>
          <div className="todo-pager editor-pager" aria-label={`待办第 ${todoPage + 1} 页，共 ${todoPages.length} 页`}>
            {todoPages.map((_, index) => <span className={index === todoPage ? "current" : ""} key={index} />)}
          </div>
        </section>
      ) : (
        <section
          className="todo-card card"
          aria-label="To-Do"
          onClickCapture={(event) => {
            if (!todoDidSwipe.current) return;
            event.preventDefault();
            event.stopPropagation();
            todoDidSwipe.current = false;
          }}
          onPointerCancel={() => { todoSwipeStart.current = null; }}
          onPointerDown={(event) => { todoSwipeStart.current = event.clientX; }}
          onPointerUp={(event) => handleTodoPointerUp(event.clientX)}
        >
          <h2>To-Do</h2>
          <div className="todo-pages-viewport">
            <div className="todo-pages-track" style={{ transform: `translateX(-${todoPage * 165}px)` }}>
              {todoPages.map((page, pageIndex) => (
                <div aria-hidden={pageIndex !== todoPage} className="todo-page" key={pageIndex}>
                  {Array.from({ length: 3 }, (_, slotIndex) => {
                    const todo = page[slotIndex];
                    if (todo) return (
                      <button
                        className={`todo-row todo-slot-${slotIndex + 1} ${todo.completed ? "completed" : ""}`}
                        key={todo.id}
                        onClick={() => home.toggleTodo(todo.id)}
                        tabIndex={pageIndex === todoPage ? 0 : -1}
                      >
                        <svg aria-hidden="true" className="check-icon" viewBox="0 0 12 12">
                          <circle cx="6" cy="6" fill="none" r="5.5" stroke="currentColor" />
                          {todo.completed ? <circle cx="6" cy="6" fill="currentColor" r="4" /> : null}
                        </svg>
                        <span className="todo-copy">
                          <span className="todo-title">{todo.title}</span>
                          {todo.time || todo.date ? <small className="todo-meta">{todo.time ? <span>{todo.time}</span> : null}{todo.date ? <span>{todo.date}</span> : null}</small> : todo.meta ? <small>{todo.meta}</small> : null}
                        </span>
                      </button>
                    );
                    if (pageIndex === todoPages.length - 1 && slotIndex === 2) return (
                      <button className="add-row todo-slot-3" aria-label="增加待办" key="add" onClick={() => setEditor("todo")} tabIndex={pageIndex === todoPage ? 0 : -1}><span className="figma-add-icon" aria-hidden="true" /></button>
                    );
                    return <span aria-hidden="true" className={`todo-empty-slot todo-slot-${slotIndex + 1}`} key={`empty-${slotIndex}`} />;
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="todo-pager" aria-label={`待办第 ${todoPage + 1} 页，共 ${todoPages.length} 页`}>
            {todoPages.map((_, index) => (
              <button aria-label={`查看待办第 ${index + 1} 页`} className={index === todoPage ? "current" : ""} key={index} onClick={() => setTodoPage(index)} type="button" />
            ))}
          </div>
        </section>
      )}

      <section className="from-card" aria-label="陪伴者的今日纸条">
        <div className="from-back from-back-deep" />
        <div className="from-back from-back-soft" />
        <div className="from-paper">
          <h2>From</h2>
          {currentNote ? <p className="current-note-preview"><span>{currentNote.time}</span>{currentNote.text}</p> : null}
          <button className="notes-toggle" onClick={() => setNotesOpen(true)} aria-label="查看今天全部纸条">
            <span className="note-chevron-shape" aria-hidden="true" />
            <span className="note-chevron-shape" aria-hidden="true" />
          </button>
        </div>
        <button className="from-heart" onClick={() => setNotesOpen(true)} aria-label="打开纸条">
          <span className="note-heart-shape" aria-hidden="true" />
        </button>
      </section>

      <section className="life-status" aria-label="共同生活状态">
        <span>{compactNumeralSpacing(home.relationship.userLastSeen)}</span>
        <span>{compactNumeralSpacing(home.relationship.companionLastSeen)}</span>
        <span>{home.relationship.startLabel} · {home.relationship.daysTogether}Days</span>
      </section>

      {notesOpen && sheetHost ? createPortal(
        <div className="modal-backdrop home-modal home-notes-modal" role="presentation" onClick={() => setNotesOpen(false)}>
          <section aria-label="今日全部纸条" className="notes-sheet" onClick={(event) => event.stopPropagation()}>
            <button className="sheet-handle" aria-label="收起纸条" onClick={() => setNotesOpen(false)} type="button" />
            <div className="drawer-header"><h2>今天的纸条</h2></div>
            {home.notes.map((note) => <article className="full-note" key={note.id}><span>{note.time}</span><p>{note.text}</p></article>)}
          </section>
        </div>,
        sheetHost,
      ) : null}

      <OceanBottomSheet detent="compact" label="编辑倒数日" onClose={() => setCountdownMenu(null)} open={Boolean(countdownMenu)}>
        {countdownMenu ? <div className="countdown-action-sheet">
          <div><small>倒数日</small><strong>{countdownMenu.title}</strong></div>
          <button onClick={() => openCountdownEditor(countdownMenu)} type="button">编辑名称与日期</button>
          <button className="danger" onClick={() => { home.removeCountdown(countdownMenu.id); setCountdownMenu(null); setCountdownIndex(0); }} type="button">删除倒数日</button>
        </div> : null}
      </OceanBottomSheet>
    </section>
  );
}
