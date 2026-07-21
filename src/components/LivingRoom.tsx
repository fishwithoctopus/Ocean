import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatAttachment, MessageTurn } from "../domain/ocean";
import type { ContinuitySnapshot } from "../domain/ocean";
import { usePersistentState } from "../hooks/usePersistentState";
import { INITIAL_CONTINUITY } from "../continuity/mockContinuity";
import { stagedMemoryAdapter } from "../adapters/mockMemory";
import { LivingFurniture } from "./LivingFurniture";
import { RoomChatChrome } from "./RoomChatChrome";
import { ConversationBubble } from "./ConversationBubble";
import { MessageActions } from "./MessageActions";
import { assetPath } from "../utils/assetPath";
import { deliverToLivingRoom } from "../services/livingRoomConversation";
import { ChatImageViewer } from "./ChatImageViewer";
import type { MessageAttachment } from "../domain/ocean";

interface LivingRoomProps {
  isNight: boolean;
  onNightChange: (value: boolean) => void;
}

const legacyReasoningStatus = "本轮使用了模型的推理模式；Ocean 不展示未经整理的内部推理原文。";
const currentReasoningStatus = "模型返回了推理过程标记，但没有提供可直接展示的思考摘要。这里仅显示状态，不展示未经整理的内部推理原文。";

function asset(name: string) {
  return assetPath(`assets/living/${name}`);
}

export function LivingRoom({ isNight, onNightChange }: LivingRoomProps) {
  const [messages, setMessages] = usePersistentState<MessageTurn[]>("ocean:chat:living-main", []);
  const [continuity, setContinuity] = usePersistentState<ContinuitySnapshot>("ocean:continuity:living-main", INITIAL_CONTINUITY);
  const [input, setInput] = useState("");
  const [nightTalk, setNightTalk] = usePersistentState("ocean:living:night-talk", false);
  const [streaming, setStreaming] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState("");
  const [viewingImage, setViewingImage] = useState<MessageAttachment | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages((current) => {
      let changed = false;
      const migrated = current.filter((turn) => {
        if (["a1", "u1", "a2"].includes(turn.id)) { changed = true; return false; }
        return true;
      }).map((turn) => {
        if (turn.reasoning?.content !== legacyReasoningStatus) return turn;
        changed = true;
        return { ...turn, reasoning: { title: "本轮进行了思考", content: currentReasoningStatus } };
      });
      return changed ? migrated : current;
    });
  }, [setMessages]);

  const latestReasoning = useMemo(
    () => messages.at(-1)?.role === "assistant" ? messages.at(-1)?.reasoning ?? null : null,
    [messages],
  );

  useEffect(() => {
    const node = conversationRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, streaming]);

  const deliver = async (value: string, attachments: ChatAttachment[] = [], baseMessages = messages) => {
    if (!value || streaming) return;
    setStreaming(true);
    setMemoryNotice("");
    const delivered = await deliverToLivingRoom(value, {
      attachments,
      continuity,
      messages: baseMessages,
      nightTalk,
      onContinuity: setContinuity,
      onMessages: setMessages,
    });
    if (delivered.continuity.forged) {
      setMemoryNotice(delivered.continuity.warning === "provider-summary-failed"
        ? "会话已续接；摘要服务暂时未响应，已使用本地摘要"
        : "会话空间已无感续接");
    }
    if (!delivered.live && /记住|记下来|存进|存入|保存到|写进/.test(value)) {
      await stagedMemoryAdapter.saveCandidate(value, "living:explicit");
      setMemoryNotice("已加入本地记忆候选，联网后同步");
    }
    setStreaming(false);
  };

  const send = async (attachments: ChatAttachment[] = []) => {
    const value = input.trim();
    if (!value || streaming) return;
    setInput("");
    await deliver(value, attachments);
  };

  const retryFromTurn = async (turnIndex: number) => {
    if (streaming) return;
    const requested = messages[turnIndex];
    const userIndex = requested?.role === "user"
      ? turnIndex
      : messages.slice(0, turnIndex).findLastIndex((turn) => turn.role === "user");
    if (userIndex < 0) return;
    const value = messages[userIndex].segments.join("\n\n").trim();
    const baseMessages = messages.slice(0, userIndex);
    setMessages(baseMessages);
    await deliver(value, [], baseMessages);
  };

  return (
    <section className={`living-room living-room-fidelity ${isNight ? "night" : "day"}`} aria-label="对话页：客厅">
      <button className="living-lamp" aria-label={isNight ? "切换到白天模式" : "切换到夜间模式"} onClick={() => onNightChange(!isNight)}>
        <svg aria-hidden="true" fill="none" height="32" viewBox="0 0 112 32" width="112">
          <g filter="url(#living-lamp-shadow)">
            <path d="M16 4H96L104 20H8L16 4Z" fill="currentColor" />
          </g>
          <defs>
            <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="32" id="living-lamp-shadow" width="112" x="0" y="0">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feColorMatrix in="SourceAlpha" result="hardAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
              <feOffset dy="4" />
              <feGaussianBlur stdDeviation="4" />
              <feComposite in2="hardAlpha" operator="out" />
              <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0" />
              <feBlend in2="BackgroundImageFix" mode="normal" result="effect1_dropShadow" />
              <feBlend in="SourceGraphic" in2="effect1_dropShadow" mode="normal" result="shape" />
            </filter>
          </defs>
        </svg>
      </button>

      <div className="living-conversation" ref={conversationRef}>
        {messages.map((turn, turnIndex) => (
          <div className={`living-turn-block role-${turn.role}`} key={turn.id}>
            {turnIndex === 2 && <div className="living-time-divider"><span>14:30</span></div>}
            <div className={`living-turn ${turn.role}`}>
              {turn.attachments?.length ? <div className="living-message-images">
                {turn.attachments.map((attachment) => (
                  <button aria-label={`放大查看 ${attachment.name}`} key={attachment.id} onClick={() => setViewingImage(attachment)}>
                    <img alt={attachment.name} src={attachment.previewDataUrl} />
                  </button>
                ))}
              </div> : null}
              {turn.segments.map((segment, index) => (
                <ConversationBubble className="living-message-bubble" key={`${turn.id}-${index}`}>{segment}</ConversationBubble>
              ))}
              {turn.segments.length === 0 && streaming && turnIndex === messages.length - 1 && <div className="living-typing-bubble"><i /><i /><i /></div>}
              {turn.segments.length > 0 && (
                <MessageActions
                  align={turn.role === "user" ? "right" : "left"}
                  copyText={turn.segments.join("\n\n")}
                  onRetry={turn.role === "assistant" ? () => void retryFromTurn(turnIndex) : undefined}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <LivingFurniture />
      {memoryNotice && <div className="living-memory-notice">{memoryNotice}</div>}
      <RoomChatChrome
        input={input}
        nightTalk={nightTalk}
        onInputChange={setInput}
        onNightTalkChange={setNightTalk}
        onSend={(attachments) => void send(attachments)}
        reasoning={latestReasoning}
        sendDisabled={!input.trim() || streaming}
        storageRemainingPercent={continuity.storage?.percentRemaining}
      />
      <ChatImageViewer attachment={viewingImage} onClose={() => setViewingImage(null)} />
    </section>
  );
}
