# Ocean UI Fidelity Baseline

## Calibration

- Canonical mobile canvas: `390 × 844` CSS px.
- Local preview (`127.0.0.1` / `localhost`) defaults to fixed phone calibration mode.
- The internal `.ocean-shell` always remains `390 × 844`; smaller preview windows scale the shell without changing its layout coordinates.
- Add `?preview=responsive` only when intentionally testing the responsive production layout.

## Screen status

### Home / 家

- Figma source: file `Zbaw4uQ9SXIFjVzl1lI50f`, node `2:2`.
- Fidelity pass: complete for the default state.
- Intentional interaction update: Todo minutes use one-minute `00-59` granularity. The shared date/time wheel keeps the measured five-row visual geometry while a native scroll-snap layer supplies touch inertia and center settling. Its cyclic logical track is virtualized to 17 nearby snap points per column, and haptics are intentionally omitted for consistent PWA behavior.
- Todo date and time remain independently enabled and are saved together. Switching the visible editor remounts the wheel surface so unfinished touch momentum from the previous date/time wheel cannot continue inside the newly opened wheel.
- Verified anchors: header `0–94`, content `94–760`, bottom navigation `760–844`.
- Installed iOS PWA mode paints the active theme canvas and wallpaper beneath the translucent native status bar. The calibrated Figma header already contains the intended status-bar whitespace, so standalone mode must not add another top inset or move the measured content downward.
- Verified modules: wordmark, calendar, countdown cards, To-Do, From note stack, relationship status, bottom room navigation.
- Countdown cards support touch long-press, context-menu, and keyboard access to the same edit/delete sheet. Completed Todos sort after active items and are removed when the local calendar date changes; legacy numeric interaction-test rows are migrated away.
- Figma SVG assets are stored locally under `public/assets/icons` and do not depend on temporary Figma URLs.
- EB Garamond is bundled locally for display text. Chinese uses the platform CJK stack; SF Pro uses the system UI stack and falls back to Segoe UI on Windows.

### Living room / 客厅

- Figma sources: day `21:425`, night `38:106`, bubble decoration `34:40`, music `83:64`, model `87:46`, usage `83:87`, attachments `91:142`.
- Fidelity pass: complete for the day/night shell, conversation stream, furniture, composer, tool controls, three anchored popovers, attachment menu, and thinking summary sheet.
- Verified anchors: header `0–94`, room content `94–760`, bottom navigation `760–844`; the thinking sheet stops exactly at the navigation's top edge.
- Music, model, and usage expansions keep one `147 × 147` Figma coordinate system. Their active anchor overlays the original button exactly; tapping outside dismisses the component.
- The song list is a touch scroll-snap wheel with cyclic recentering; click remains only an accessibility/desktop fallback. Playback data is still connector-owned rather than presented as a completed NetEase integration.
- Music, model, and usage triggers use the measured Figma centers as one evenly spaced group. The right chair is horizontally mirrored; both furniture pieces and their character drawings use the original vector bounds rather than approximate image boxes.
- Long mock replies stream as separate semantic bubbles while remaining one assistant turn in persisted conversation state.
- Visual night mode and the `夜谈氛围` prompt flag are independent states.
- The night composer remains a light local surface, so its input value, placeholder, and caret use the theme's explicit local-surface foreground rather than inheriting the light page foreground. The four built-in theme pairs pass the WCAG 2.2 `4.5:1` normal-text threshold.
- The shell owns the visual layer order: theme canvas, wallpaper at 40% opacity, then transparent room content. Ocean, peach, and mono themes each provide day/night furniture, icon, wallpaper-filter, bubble, and canvas tokens.
- Model selection uses progressive disclosure inside a `230 × 217` anchored panel: the first view lists only parameters supported by the current model; choosing a row opens one full-width swipe wheel in place. This scales to model, runtime variant, reasoning effort, speed, and future manifest-defined controls without creating unreadable narrow columns.
- The model editor back control uses a fixed `12 × 12` outlined SVG rather than a font chevron. Its visible vector center and the dynamic text label share one measured flex center; the label remains real text for localization and accessibility.
- While Music, Model, or Usage is expanded, the three underlying tool triggers are hidden as one group and the active anchor inside the panel assumes the selected trigger's exact coordinates. The panel surface fills its complete measured outer frame, so wallpaper and dormant controls cannot leak through its edge or rounded-corner inset.
- Intentional PRD difference: the attachment component is a GPT-like menu with `40px` rows, rather than the older narrow Figma frame, so touch targets remain comfortable. Camera, system image picker, supported local text files, and configured read-only connectors now create real per-turn attachment payloads; `夜谈氛围` remains the fifth living-room action.
- Custom decorative bubble skins are intentionally deferred. The current build keeps the measured generic bubble geometry and does not paste the sample decoration SVG over it.
- Exact Living Room exports are stored under `public/assets/living`.

### Study / 书房 · 项目模式

- Figma sources: project screen `75:239`, project action menu `99:130`.
- Fidelity pass: complete for the project-mode shell, compact mode switcher, work-duration pill, collapsed and expanded bookshelf states, provider-backed project conversation, shared chat controls, composer, and anchored project action menu.
- Verified anchors on the canonical `390 × 844` canvas: work duration `20,88 / 116×38`; mode switcher `20,130 / 260×40`; TO-DO shelf `20,182 / 350×160`; expanded DONE shelf `20,330 / 350×160`; tool row `199,680 / 142×24`; composer `20,708 / 350×44`.
- The shelf geometry uses the measured two-layer construction: a `350×160` ink outer cabinet and a `326×136` inset surface cavity. Books and fixed TO-DO/DONE labels are independent elements, not one decorative shelf image.
- Product behavior intentionally follows the PRD rather than the expanded-state screenshot alone: a fresh project screen starts with only TO-DO visible; the exact Figma expanded state appears after the shelf arrow is pressed. The DONE row remains horizontally scrollable.
- TO-DO and DONE both support multiple horizontally scrollable project books. Unselected books stay within the blue-purple palette; the active project alone uses the warm Ocean accent. Project titles keep the measured vertical writing direction with deliberately loosened character spacing.
- The final TO-DO book is an in-shelf add spine, not a detached drawer trigger. It expands into a compact editor anchored to the existing cabinet and dismisses on outside tap. The same structured `createProject` action also handles explicit commands such as `创建一个名为 Ocean 的项目`; ordinary mentions never create records or call a model.
- Project and Meeting render the same Gateway project registry and active `projectId`. A project created in either shared shelf therefore appears immediately in both modes, while their conversations remain isolated as `project:<projectId>` and `meeting:<projectId>`.
- Project books support pointer long-press and context-menu access to the measured-width `80×121` space/edit/archive/download component. The composer plus reuses the Living Room GPT-style real camera/image/file/connector menu; tapping outside dismisses either surface.
- Project Space is an intentional PRD extension rather than a replacement for the calibrated shelf. It opens as a detent-based sheet above the global navigation and stores project brief, typed documents and uploaded files in the Gateway project directory. The sheet uses the same semantic surface, shadow, radius and minimum-text rules as the rest of Ocean.
- `RoomChatChrome` is shared by Living and Study rather than visually duplicated. Music, model, usage, composer, popovers, and the Thinking summary therefore keep the same SVG geometry and interaction behavior; Study only supplies measured positional offsets and project actions.
- The compact mode switcher remains clickable above the project stage. Each SVG is rendered at its intrinsic visible size inside a common `24×24` slot, avoiding the distortion caused by stretching different viewBoxes to one box.
- The shelf disclosure button is placed by geometry at `(160 - 24) / 2 = 68px`, so its control box is vertically centered in the cabinet in both collapsed and expanded states.
- Each project keeps an independent provider-backed conversation with an offline mock fallback. The first user input carries the one-time work-mode context as structured sync metadata; subsequent turns do not repeat it. Legacy three-bubble placeholder records are removed by ID.
- Exact Figma SVG assets are stored under `public/assets/study`; the shared composer and chat-tool SVGs reuse the already verified Living Room assets.

### Study / 书房 · 共读模式

- Figma sources: reading screen `94:102`, reading plus menu `98:63`.
- The measured page card is `20,182 / 350×440` on the canonical `390×844` canvas, with `12px` horizontal padding, `22px` top padding, `16px` CJK text, `22px` line height, and `2px` tracking.
- Reading reuses the exact Study/Living `RoomChatChrome`, desk, Thinking summary, model, music and usage controls. Its attachment actions use the original Figma bookmark, annotation and question SVGs.
- The bookshelf remains an independent layer behind the open page. Books come from the co-reading adapter; active books use the warm accent and each book owns a separate `reading:<bookId>` conversation.
- The shared work/reading duration pill uses intrinsic width with `12px` horizontal padding, so Project and Reading labels grow with their content instead of overflowing a fixed rectangle.
- A compact page navigator adds previous chunk, next chunk and book switching without changing the Figma page-card geometry. The action feedback pill is intrinsic-width and horizontally centered on the `390px` canvas.
- Native text selection opens an inline note editor beneath the quote. User and assistant annotations are rendered from the upstream annotation records as cool and warm highlights; click, focus or hover opens the note thread.
- The annotation editor keeps notes private by default and uses the shared `MiniSwitch` for `同时推给陪伴者`. The switch changes the behavior of the single final `留下` action; it is not a second submit button. Sharing submits only the current chunk's open notes and reveals the book-scoped conversation.
- A failed co-reading request keeps the calibrated reading surface in place and offers a small in-surface `重新连接` action. Retrying reloads the real Gateway adapter without replacing the page card with mock content.
- The page-edge chevron collapses the `350×440` reading card to `350×276`, opening a `300×150` book-scoped conversation area while preserving the original lower navigation and composer geometry.
- The page toggle now lives in a fixed 24px toolbar at the reading card's upper-right as a two-corner expand mark. The same toolbar centers transient attachment hints as small muted text; successful page turns are silent, while failures use a white centered toast.
- The reading card uses a soft depth shadow plus a surface-colored 1px outer ring to hide dark bookshelf antialiasing at the upper corners. Reading duration and mode controls use a lighter shadow tier.
- The book-scoped conversation label is carried by the composer placeholder and disappears naturally as soon as the user types.
- In Reading mode, the Thinking bubbles are mirrored to the left of the desk's small fish mark so they no longer overlap it.
- Preview can switch between Mock data and the real `co-reading-mcp` through Ocean Gateway without changing component structure.

### Leisure / 休闲 · 自由时间

- Figma source: leisure screen `94:584`; the activity frame is `20,100 / 350×168` and its inset surface is `32,112 / 326×144` on the canonical canvas.
- The activity timeline uses the measured text origin `56,133`, three fixed `17px` rows beginning at `y=183`, and the V/A line at `56,230`. The mascot keeps the original `223,136 / 118×88` crop instead of sharing or overlapping the timeline column.
- Completed outcomes for the local calendar day are sorted oldest-to-newest and capped at three. A lone outcome occupies row one at full emphasis; later outcomes fill downward, rebalance older rows to 40/60% emphasis, and evict the oldest only after row three is full.
- Each compact outcome row is a real button. It opens the shared detent-based bottom sheet with the complete summary, local timestamp, valence, and arousal; outside tap and the sheet handle dismiss it.
- Empty state remains data-derived and never fabricates actions or affect values. Manual trigger continues to write a real Gateway outcome rather than adding a local mock row.

### Palace / Daily Impression

- The Daily Impression card keeps the calibrated `333px` baseline as a minimum height rather than a fixed height. Long Memory 3.0 bodies, preserved paragraph breaks, and unbroken identifiers expand the card naturally inside the existing Palace scroll container, so the surface always remains behind its content.

### Shared chat-state refinements

- The access/loading status line uses the same three-dot pulse component on both sides of its live status copy. Ellipsis characters are not embedded in the copy, so both visual groups animate and reduced-motion mode can disable them consistently without changing the line's geometry.
- The send button is disabled only for an empty draft or while the model response stream is active. It unlocks on the stream's `done` event; continuity forging and durable conversation sync finish afterward without extending the visible sending lock.
- Dynamic model labels may wrap to two lines. The shared model trigger and its expanded-panel anchor grow upward from a fixed bottom baseline, so longer names gain breathing room without moving the composer or adjacent controls.
- Meeting keeps the calibrated project-mode shell and avatar geometry. Its participant panel now derives only Kimi K3, GPT 5.6, Sonnet 4.6 and Opus 4.6 from the live Gateway registry; GPT participates and Opus hosts by default when both are available. A round streams each participant's final answer in order and then the host's visible synthesis, while a failed provider becomes one explicit skipped bubble without moving or replacing the existing controls.
- Meeting bubbles use a bottom-anchored flex stack rather than screenshot coordinates. Bubble copy wraps naturally; consecutive turns from one participant use `6px`, while participant changes use `12px`, matching the shared conversation rhythm without overflowing the mobile canvas.
- The meeting transcript owns a fixed `188px` viewport between the bookshelf and shared chat controls. It keeps the complete meeting history, supports inertial one-finger vertical scrolling on iOS, and never delegates overflow to the fixed `390 × 844` room canvas. Bubble wrappers are intrinsic-height and hard-wrap long unbroken provider text.
- Every persisted conversational turn exposes compact copy plus retry actions beneath its bubble group. Living-room retry replaces the selected assistant turn from its preceding user message; a user `重说` reopens the same prompt. Meeting retry regenerates only the selected participant response, while a user `重说` returns the topic to the composer for editing.
- The Thinking bubbles are a live reasoning-state indicator, not permanent decoration. They appear only when the newest assistant turn contains a provider reasoning summary; historical reasoning does not keep the indicator visible, and mock Project/Reading screens do not fabricate it.
- Calendar countdowns preserve their selected month/day as an annual event after the original target passes: the target day reads zero, and the following day begins counting toward the next year's occurrence.
- Empty shelves, meeting bubbles and free-time activity history now remain genuinely empty until user or Gateway data exists. The leisure card reads the local current date and only renders completed scheduler outcomes; its V/A line comes from the most recent completed outcome.
- When the server cost gate for automatic free-time dispatch is disabled, the existing manual-trigger control says `手动触发 · 自动未开` instead of making an unpaused rule set look like a running automatic model. The active-hours rule is evaluated in Ocean's configured timezone rather than the container's UTC clock.
- Project, reading and meeting duration pills share a daily foreground timer. The labels grow intrinsically, start from zero for a fresh local day, and keep each mode's accumulated time separate.
- The shared theme and settings header circles are `39px` while their original centers and inner SVG geometry remain unchanged.
- The canonical `84px` mobile navigation already includes the iPhone home-indicator safe zone. Standalone PWA mode must not add `env(safe-area-inset-bottom)` a second time; doing so overflows the calibrated `390 × 844` composition and clips the navigation surface.
- Production PWA registration bypasses the HTTP cache for `sw.js`, checks for updates on load, focus, and foreground return, and reloads once after a new worker takes control. Visual fixes therefore no longer depend on users repeatedly clearing the iOS app switcher.
- In standalone iOS, the fixed 84px Figma navigation remains geometrically unchanged and owns its complete white surface. No extra bottom row, padding, overlay, or pseudo-surface is added outside it.
- Bottom-navigation icon and outlined-label SVGs remain in one measured coordinate system but render in separate layers. The five outlined labels occupy a dedicated navigation-background layer outside the button/icon clipping contexts, preserving the original coordinates and theme color inheritance.
- Historical production CSS from the cache-testing build was retained and compared before the navigation repair; bottom behavior should be restored by removing later ownership, not by adding a compensating overlay.
- The JavaScript-detected standalone class is state-only and must not alter the calibrated `94 + 666 + 84 = 844px` geometry. The design already reserves both system-edge clearances inside that composition.
- The music popover remains the calibrated `147x147` Figma surface. Overflowing playlist names use a measured, reversible horizontal pan; short names remain centered and motion stops under `prefers-reduced-motion`.
- Music playback success no longer adds a duplicate artist/title line below the selected wheel row. The original bottom control band now contains five symmetric actions: single repeat, pause/resume, list repeat, next track, and shuffle.
- The five playback actions and transient playback status are centered from the `147px` panel axis rather than offset from the left music anchor. Five `18px` circles with `1px` gaps preserve the anchor without visual overlap.

## Next screen

- Study / 书房: poetry mode Figma node `94:268`.
- Poetry / 情诗 now uses the measured `350×160` `FOR YOU` shelf, the original `80×96` long-press menu language from node `99:157` extended to `80×128` for four equal action rows, and the centered full-poem surface from node `99:172`. Book heights are content-derived from vertical title length; resting books rotate through blue-purple plus restrained light/deep peach tones, while the first poem next to `FOR YOU` must not repeat its exact tone. The fixed label remains stationary, the strip shows 13 complete spines per view, and additional poems scroll horizontally with spine-boundary snapping so rounded corners are never clipped at rest. The bottom composer grows upward one text line at a time while its right icon stores the poem.
- Editing a stored poem exposes a compact real title input above the existing body composer. Saving updates both title and body while preserving the measured shelf and full-poem presentation.
- Meeting / 会议 reuses the project screen's exact `TO-DO` / `DONE` shelf and selected project state. Its main structural variation is a three-speaker bubble layer using the bird, fish, and octopus line avatars extracted from Figma node `94:425`; the tool cluster, model panel, usage panel, and composer are shared rather than redrawn, while the decoration and thinking behavior remain meeting-specific.
- Conversation rhythm is semantic rather than index-positioned: consecutive bubbles from the same speaker use `6px`, while a speaker change uses `12px`. Meeting uses the complete Figma group exported from node `94:562`, removes the thinking affordance, and provides functional participant, round-count, and minutes panels from the plus menu. Shared Usage surfaces contain only cost, daily cost, balance, and session-forge storage remaining; this final metric belongs to the Ocean session rather than any participant model.
- Meeting node `94:562` and co-reading node `94:244` must be used as whole transparent Figma exports. Do not reconstruct, rotate, mirror, or independently position their internal SVG parts with CSS.
