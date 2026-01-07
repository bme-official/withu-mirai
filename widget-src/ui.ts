import type { WidgetState } from "./stateMachine";
import { UI_TEXT, WIDGET_VERSION } from "./constants";

export type UiLayout = "bubble" | "page";

export type UiCallbacks = {
  onToggleOpen(open: boolean): void;
  onUserGesture(): void;
  onSelectMode(mode: "voice" | "text"): void;
  onSendText(text: string): void;
  onToggleMicMuted(muted: boolean): void;
  onToggleSpeakerMuted(muted: boolean): void;
  onAcceptConsent(): void;
  onRejectConsent(): void;
};

export type UiController = {
  mount(): void;
  setOpen(open: boolean): void;
  setState(state: WidgetState): void;
  setListeningRms(rms: number): void;
  setMode(mode: "voice" | "text"): void;
  setProfile(profile: { displayName: string; avatarUrl: string | null }): void;
  setIntimacy(level: number | null): void;
  setMicMuted(muted: boolean): void;
  setSpeakerMuted(muted: boolean): void;
  appendMessage(role: "user" | "assistant", content: string): void;
  setError(msg: string | null): void;
  setConsentVisible(visible: boolean): void;
  setTextFallbackEnabled(enabled: boolean): void;
};

export function createUi(cb: UiCallbacks, opts?: { layout?: UiLayout }): UiController {
  const hostId = "withu-voice-widget-host";
  let open = false;
  const layout: UiLayout = opts?.layout ?? "bubble";

  const host = document.createElement("div");
  host.id = hostId;
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  if (layout === "page") {
    host.style.top = "0";
    host.style.left = "0";
    host.style.right = "0";
    host.style.bottom = "0";
  } else {
    host.style.right = "16px";
    host.style.bottom = "16px";
  }

  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .bubble {
      width: 56px; height: 56px; border-radius: 9999px;
      background: #111827; color: white; border: 1px solid rgba(255,255,255,0.12);
      display:flex; align-items:center; justify-content:center;
      cursor: pointer; user-select: none;
      box-shadow: 0 10px 30px rgba(0,0,0,0.25);
      font: 14px/1.2 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }
    .panel {
      width: min(360px, calc(100vw - 32px));
      height: 480px;
      background: white;
      border-radius: 16px;
      border: 1px solid rgba(0,0,0,0.12);
      box-shadow: 0 24px 60px rgba(0,0,0,0.25);
      overflow: hidden;
      display: none;
      margin-bottom: 12px;
      font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      color: #111827;
    }
    .panel.open { display: flex; flex-direction: column; }
    .page .bubble { display: none !important; }
    .page .panel {
      width: 100vw;
      /* Use JS-measured viewport height on mobile so footer stays visible above browser UI. */
      height: var(--withu-vh, 100dvh);
      max-height: var(--withu-vh, 100dvh);
      border-radius: 0;
      margin-bottom: 0;
    }
    .page .header { padding: 16px 16px; }
    .page .log { padding: 16px; }
    .page .composer { padding: 16px; }
    .page .footer { padding: 16px; }
    .page .status { display:none; }
    /* Page layout: mobile is single column; desktop becomes 2 columns in text mode */
    .page .panel.open {
      display: grid;
      grid-template-columns: 1fr;
      grid-template-rows: auto auto 1fr auto auto;
      grid-template-areas:
        "header"
        "hero"
        "log"
        "composer"
        "footer";
    }
    .page .header { grid-area: header; }
    .page .hero { grid-area: hero; }
    .page .log { grid-area: log; }
    .page .composer { grid-area: composer; }
    .page .footer { grid-area: footer; }

    /* Voice mode: hero-centered single column even on desktop */
    .page .panel.voiceOnly.open {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr auto;
      grid-template-areas:
        "header"
        "hero"
        "footer";
    }

    @media (min-width: 900px) {
      .page .panel.open:not(.voiceOnly) {
        grid-template-columns: 380px 1fr;
        grid-template-rows: auto 1fr auto auto;
        grid-template-areas:
          "header header"
          "hero log"
          "hero composer"
          "hero footer";
      }
      .page .hero {
        height: 100%;
        justify-content: flex-start;
        padding-top: 36px;
        border-bottom: none;
        border-right: 1px solid rgba(0,0,0,0.06);
        background: #f9fafb;
      }
      .page .log { padding: 18px; }
      .page .composer { padding: 18px; }
      .page .footer { padding: 18px; }
    }

    /* SP (mobile): match requested layout */
    .footerControls {
      display: none;
      width: 100%;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    @media (max-width: 640px) {
      .page .header { display: none; }
      .page .footer {
        position: sticky;
        bottom: 0;
        background: #fff;
        padding-bottom: calc(16px + env(safe-area-inset-bottom));
      }
      .page .footerControls { display: flex; }

      /* Voice mode: hero avatar should fill the entire hero area (full-bleed) */
      .page .panel.voiceOnly .heroAvatar { width: 100%; height: 100%; }

      /* Voice mode: hero (avatar+status) then bottom controls only */
      .page .panel.voiceOnly.open {
        grid-template-columns: 1fr;
        grid-template-rows: 1fr auto;
        grid-template-areas:
          "hero"
          "footer";
      }

      /* Text mode: log -> composer (input) -> footer (fixed controls) */
      .page .panel.open:not(.voiceOnly) {
        grid-template-columns: 1fr;
        grid-template-rows: 1fr auto auto;
        grid-template-areas:
          "log"
          "composer"
          "footer";
      }
      .page .panel.open:not(.voiceOnly) .hero { display: none; }
    }
    .header {
      display:flex; align-items:center; justify-content:space-between;
      padding: 12px 12px;
      border-bottom: 1px solid rgba(0,0,0,0.08);
      background: #f9fafb;
    }
    .title { font-weight: 700; display:flex; align-items:center; gap:10px; }
    .avatar {
      width: 36px; height: 36px; border-radius: 9999px;
      overflow: hidden; border: 1px solid rgba(0,0,0,0.12);
      background: linear-gradient(135deg, #111827, #6d28d9);
      flex: none;
    }
    .hero {
      padding: 0;
      background: linear-gradient(180deg, #f9fafb, rgba(249,250,251,0.0));
      border-bottom: 1px solid rgba(0,0,0,0.06);
      display:flex;
      flex-direction: column;
      align-items:center;
      gap: 10px;
      min-height: 260px; /* ensure height even if children are absolutely positioned */
    }
    .page .hero { padding-top: 0; }
    .heroAvatar {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border-radius: 0;
      overflow:hidden;
      border: none;
      box-shadow: none;
      background: #111827;
    }
    .heroAvatar.listening {
      filter: saturate(1.05) brightness(1.02);
    }
    .heroAvatar.thinking {
      filter: saturate(1.03) brightness(1.01);
    }
    .heroAvatar.speaking {
      filter: saturate(1.06) brightness(1.03);
    }
    .heroAvatar img { width:100%; height:100%; object-fit:cover; display:block; }
    .heroBottom {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 18px 16px 14px 16px;
      display:flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      color: white;
      text-shadow: 0 2px 10px rgba(0,0,0,0.35);
    }
    .heroBottom::before {
      content: "";
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 160px;
      background: linear-gradient(180deg, rgba(0,0,0,0.0), rgba(0,0,0,0.55));
      pointer-events: none;
    }
    .heroBottom > * { position: relative; z-index: 1; }
    .heroName { font-weight: 800; font-size: 16px; }
    .heroStatusLine {
      display:flex;
      align-items:center;
      gap: 8px;
      font-size: 12px;
      font-weight: 700;
      opacity: 0.8;
      min-height: 18px;
    }
    .heroStatusDot {
      width: 10px;
      height: 10px;
      border-radius: 9999px;
      background: rgba(17,24,39,0.35);
    }
    .heroStatusDot.listening { background: rgba(16,185,129,0.85); }
    .heroStatusDot.thinking { background: rgba(59,130,246,0.85); }
    .heroStatusDot.speaking { background: rgba(109,40,217,0.85); }
    .heroStatusText { letter-spacing: 0.01em; }
    .listenBars {
      display: inline-flex;
      align-items: flex-end;
      gap: 3px;
      height: 14px;
      margin-left: 8px;
      opacity: 0.9;
    }
    .listenBars span {
      width: 3px;
      height: 12px;
      /* brighter for visibility on the hero overlay */
      background: rgba(255,255,255,0.92);
      border-radius: 9999px;
      transform-origin: bottom;
      transform: scaleY(0.15);
      transition: transform 60ms linear, opacity 120ms ease;
      opacity: 0.55;
    }
    .heroStatusDot.listening + .heroStatusText .listenBars span { opacity: 0.9; }
    .dots {
      display:inline-flex;
      gap: 3px;
      margin-left: 4px;
      transform: translateY(1px);
    }
    .dots span {
      width: 4px; height: 4px; border-radius: 9999px;
      background: currentColor;
      opacity: 0.25;
      animation: dotPulse 1.1s infinite ease-in-out;
    }
    .dots span:nth-child(2) { animation-delay: 0.12s; }
    .dots span:nth-child(3) { animation-delay: 0.24s; }
    @keyframes dotPulse {
      0%, 100% { opacity: 0.18; transform: translateY(0); }
      50% { opacity: 0.9; transform: translateY(-1px); }
    }
    .avatar.speaking {
      border-color: rgba(109,40,217,0.55);
      box-shadow: 0 0 0 4px rgba(109,40,217,0.18);
    }
    .avatar img { width: 100%; height: 100%; object-fit: cover; display:block; }
    .nameWrap { display:flex; flex-direction: column; min-width: 0; }
    .name { font-weight: 700; font-size: 13px; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: 11px; opacity: 0.6; }
    .status {
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 9999px;
      background: rgba(0,0,0,0.06);
    }
    .status.speaking {
      background: rgba(109,40,217,0.12);
      color: #6d28d9;
      border: 1px solid rgba(109,40,217,0.25);
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.04); }
      100% { transform: scale(1); }
    }
    .modeTabs { display:flex; gap: 8px; }
    .modeSwitch {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      user-select: none;
      font-size: 12px;
      font-weight: 700;
    }
    .modeSwitch .modeLabel { opacity: 0.7; }
    .modeSwitch[data-mode="voice"] .modeLabel.voice { opacity: 1; }
    .modeSwitch[data-mode="text"] .modeLabel.text { opacity: 1; }
    .modeSwitch input { display:none; }
    .modeSwitch .track {
      width: 56px;
      height: 28px;
      border-radius: 9999px;
      background: rgba(0,0,0,0.10);
      border: 1px solid rgba(0,0,0,0.12);
      position: relative;
      display: inline-block;
      flex: none;
    }
    .modeSwitch .thumb {
      width: 24px;
      height: 24px;
      border-radius: 9999px;
      background: white;
      border: 1px solid rgba(0,0,0,0.12);
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      left: 2px;
      box-shadow: 0 6px 16px rgba(0,0,0,0.18);
      transition: left 160ms ease;
    }
    .modeSwitch[data-mode="text"] .thumb { left: 30px; }
    .modeSwitch:focus-within .track {
      outline: 3px solid rgba(109,40,217,0.25);
      outline-offset: 2px;
      border-color: rgba(109,40,217,0.35);
    }
    .muteBtn {
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 9999px;
      border: 1px solid rgba(0,0,0,0.12);
      background: white;
      cursor: pointer;
      user-select:none;
    }
    .muteBtn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      line-height: 1;
    }
    .muteBtn svg { width: 16px; height: 16px; display:block; }
    .muteBtn.muted {
      border-color: rgba(239,68,68,0.35);
      background: rgba(239,68,68,0.08);
    }
    .log {
      flex: 1;
      overflow: auto;
      padding: 12px;
      display:flex;
      flex-direction: column;
      gap: 10px;
      background: white;
    }
    .composer {
      padding: 12px;
      border-top: 1px solid rgba(0,0,0,0.08);
      background: white;
    }
    .hideLog .log { display:none; }
    .msg {
      max-width: 90%;
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid rgba(0,0,0,0.08);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.user { align-self: flex-end; background: #111827; color: white; border-color: rgba(0,0,0,0.1); }
    .msg.assistant { align-self: flex-start; background: #f3f4f6; }
    .footer {
      padding: 12px;
      border-top: 1px solid rgba(0,0,0,0.08);
      background: #f9fafb;
      display:flex;
      flex-direction: column;
      gap: 10px;
    }
    .row { display:flex; gap: 8px; }
    button {
      appearance: none;
      border: 1px solid rgba(0,0,0,0.12);
      background: white;
      padding: 10px 12px;
      border-radius: 12px;
      cursor: pointer;
      font-weight: 600;
    }
    button.primary { background: #111827; border-color: #111827; color: white; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    textarea {
      width: 100%;
      min-height: 44px;
      max-height: 120px;
      resize: vertical;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(0,0,0,0.12);
      font: inherit;
      background: white;
    }
    .error {
      font-size: 12px;
      color: #b91c1c;
      display: none;
    }
    .error.show { display: block; }
    .consent {
      border: 1px solid rgba(0,0,0,0.12);
      background: #fff7ed;
      color: #7c2d12;
      border-radius: 12px;
      padding: 10px 12px;
      display: none;
    }
    .consent.show { display: block; }
    .consent .small { font-size: 12px; opacity: 0.9; margin-top: 4px; }
    .muted { font-size: 12px; opacity: 0.7; }
  `;

  // In page layout, the widget occupies the whole screen. Lock page scroll so only the log scrolls in text mode.
  const prevScrollLock = {
    htmlOverflow: "",
    htmlHeight: "",
    bodyOverflow: "",
    bodyHeight: "",
    bodyOverscroll: "",
    bodyTouchAction: "",
  };
  function lockPageScroll(enable: boolean) {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    const body = document.body;
    if (!html || !body) return;
    if (enable) {
      prevScrollLock.htmlOverflow = html.style.overflow || "";
      prevScrollLock.htmlHeight = html.style.height || "";
      prevScrollLock.bodyOverflow = body.style.overflow || "";
      prevScrollLock.bodyHeight = body.style.height || "";
      prevScrollLock.bodyOverscroll = (body.style as any).overscrollBehavior || "";
      prevScrollLock.bodyTouchAction = (body.style as any).touchAction || "";
      html.style.overflow = "hidden";
      html.style.height = "100%";
      body.style.overflow = "hidden";
      body.style.height = "100%";
      (body.style as any).overscrollBehavior = "none";
      (body.style as any).touchAction = "none";
    } else {
      html.style.overflow = prevScrollLock.htmlOverflow;
      html.style.height = prevScrollLock.htmlHeight;
      body.style.overflow = prevScrollLock.bodyOverflow;
      body.style.height = prevScrollLock.bodyHeight;
      (body.style as any).overscrollBehavior = prevScrollLock.bodyOverscroll;
      (body.style as any).touchAction = prevScrollLock.bodyTouchAction;
    }
  }

  const wrap = document.createElement("div");
  wrap.className = layout === "page" ? "page" : "";

  const panel = document.createElement("div");
  panel.className = "panel";

  const header = document.createElement("div");
  header.className = "header";

  const title = document.createElement("div");
  title.className = "title";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  const avatarImg = document.createElement("img");
  avatarImg.alt = "avatar";
  avatarImg.src =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs><rect width="200" height="200" rx="100" fill="url(#g)"/><circle cx="80" cy="88" r="12" fill="white" opacity="0.9"/><circle cx="125" cy="88" r="12" fill="white" opacity="0.9"/><path d="M70 130c18 18 48 18 66 0" stroke="white" stroke-width="10" stroke-linecap="round" fill="none" opacity="0.9"/></svg>`,
    );
  avatar.appendChild(avatarImg);

  const nameWrap = document.createElement("div");
  nameWrap.className = "nameWrap";
  const nameEl = document.createElement("div");
  nameEl.className = "name";
  nameEl.textContent = UI_TEXT.title;
  const subEl = document.createElement("div");
  subEl.className = "sub";
  subEl.textContent = "Mirai Aizawa";
  let currentDisplayName = "Mirai Aizawa";
  let currentIntimacy: number | null = null;
  nameWrap.appendChild(nameEl);
  nameWrap.appendChild(subEl);

  title.appendChild(avatar);
  title.appendChild(nameWrap);

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "idle";

  function createModeSwitch(): { root: HTMLLabelElement; input: HTMLInputElement } {
    // Left = Voice (unchecked), Right = Text (checked)
    const root = document.createElement("label");
    root.className = "modeSwitch";
    root.setAttribute("role", "switch");
    root.setAttribute("aria-label", "mode toggle");
    root.setAttribute("aria-checked", "false");
    root.setAttribute("data-mode", "voice");
    root.tabIndex = 0;

    const voice = document.createElement("span");
    voice.className = "modeLabel voice";
    voice.textContent = UI_TEXT.voice;

    const input = document.createElement("input");
    input.type = "checkbox";

    const track = document.createElement("span");
    track.className = "track";
    const thumb = document.createElement("span");
    thumb.className = "thumb";
    track.appendChild(thumb);

    const text = document.createElement("span");
    text.className = "modeLabel text";
    text.textContent = UI_TEXT.text;

    root.appendChild(voice);
    root.appendChild(input);
    root.appendChild(track);
    root.appendChild(text);

    return { root, input };
  }

  const headerMode = createModeSwitch();

  const right = document.createElement("div");
  right.style.display = "flex";
  right.style.alignItems = "center";
  right.style.gap = "8px";
  const micMuteBtn = document.createElement("div");
  micMuteBtn.className = "muteBtn";
  micMuteBtn.setAttribute("role", "button");
  micMuteBtn.setAttribute("tabindex", "0");
  micMuteBtn.setAttribute("aria-label", "mic mute toggle");
  const speakerMuteBtn = document.createElement("div");
  speakerMuteBtn.className = "muteBtn";
  speakerMuteBtn.setAttribute("role", "button");
  speakerMuteBtn.setAttribute("tabindex", "0");
  speakerMuteBtn.setAttribute("aria-label", "speaker mute toggle");
  right.appendChild(headerMode.root);
  right.appendChild(micMuteBtn);
  right.appendChild(speakerMuteBtn);
  right.appendChild(status);

  header.appendChild(title);
  header.appendChild(right);

  // Page "hero" (center avatar + speaking feel)
  const hero = document.createElement("div");
  hero.className = "hero";
  hero.style.position = "relative";
  const heroAvatar = document.createElement("div");
  heroAvatar.className = "heroAvatar";
  const heroAvatarImg = document.createElement("img");
  heroAvatarImg.alt = "avatar";
  heroAvatarImg.src = avatarImg.src;
  heroAvatar.appendChild(heroAvatarImg);

  const heroName = document.createElement("div");
  heroName.className = "heroName";
  heroName.textContent = "Mirai Aizawa";

  const heroStatusLine = document.createElement("div");
  heroStatusLine.className = "heroStatusLine";
  const heroStatusDot = document.createElement("div");
  heroStatusDot.className = "heroStatusDot";
  const heroStatusText = document.createElement("div");
  heroStatusText.className = "heroStatusText";
  const heroStatusLabel = document.createElement("span");
  heroStatusLabel.textContent = "Ready";
  const listenBars = document.createElement("span");
  listenBars.className = "listenBars";
  listenBars.innerHTML = `<span></span><span></span><span></span>`;
  const dots = document.createElement("span");
  dots.className = "dots";
  dots.innerHTML = `<span></span><span></span><span></span>`;
  dots.style.display = "none";
  heroStatusText.appendChild(heroStatusLabel);
  heroStatusText.appendChild(listenBars);
  heroStatusText.appendChild(dots);
  heroStatusLine.appendChild(heroStatusDot);
  heroStatusLine.appendChild(heroStatusText);

  const heroBottom = document.createElement("div");
  heroBottom.className = "heroBottom";
  heroBottom.appendChild(heroStatusLine);
  heroBottom.appendChild(heroName);

  hero.appendChild(heroAvatar);
  hero.appendChild(heroBottom);

  const log = document.createElement("div");
  log.className = "log";

  // Composer (text input area) lives OUTSIDE footer and sits directly under the log.
  const composer = document.createElement("div");
  composer.className = "composer";

  const footer = document.createElement("div");
  footer.className = "footer";
  // footer controls (for mobile layout): mute + mode toggle
  const footerControls = document.createElement("div");
  footerControls.className = "footerControls";
  const footerMuteGroup = document.createElement("div");
  footerMuteGroup.style.display = "flex";
  footerMuteGroup.style.alignItems = "center";
  footerMuteGroup.style.gap = "8px";
  const footerMicMuteBtn = document.createElement("div");
  footerMicMuteBtn.className = "muteBtn";
  footerMicMuteBtn.setAttribute("role", "button");
  footerMicMuteBtn.setAttribute("tabindex", "0");
  footerMicMuteBtn.setAttribute("aria-label", "mic mute toggle");
  const footerSpeakerMuteBtn = document.createElement("div");
  footerSpeakerMuteBtn.className = "muteBtn";
  footerSpeakerMuteBtn.setAttribute("role", "button");
  footerSpeakerMuteBtn.setAttribute("tabindex", "0");
  footerSpeakerMuteBtn.setAttribute("aria-label", "speaker mute toggle");
  footerMuteGroup.appendChild(footerMicMuteBtn);
  footerMuteGroup.appendChild(footerSpeakerMuteBtn);

  const footerMode = createModeSwitch();

  footerControls.appendChild(footerMuteGroup);
  footerControls.appendChild(footerMode.root);

  const error = document.createElement("div");
  error.className = "error";

  const consent = document.createElement("div");
  consent.className = "consent";
  consent.innerHTML = `
    <div><b>${UI_TEXT.consentTitle}</b></div>
    <div class="small">
      ${UI_TEXT.consentBody}
    </div>
    <div class="row" style="margin-top: 8px;">
      <button data-act="consent-reject">${UI_TEXT.consentReject}</button>
      <button class="primary" data-act="consent-accept">${UI_TEXT.consentAccept}</button>
    </div>
  `;

  const textRow = document.createElement("div");
  textRow.className = "row";

  const textarea = document.createElement("textarea");
  textarea.placeholder = UI_TEXT.placeholder;
  textarea.disabled = false;

  const sendBtn = document.createElement("button");
  sendBtn.textContent = UI_TEXT.send;

  textRow.appendChild(textarea);
  textRow.appendChild(sendBtn);
  composer.appendChild(textRow);

  const meta = document.createElement("div");
  meta.className = "muted";
  meta.textContent = `withu widget v${WIDGET_VERSION}`;

  footer.appendChild(error);
  footer.appendChild(consent);
  footer.appendChild(footerControls);
  footer.appendChild(meta);

  panel.appendChild(header);
  panel.appendChild(hero);
  panel.appendChild(log);
  panel.appendChild(composer);
  panel.appendChild(footer);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = "🎙";

  wrap.appendChild(panel);
  wrap.appendChild(bubble);

  shadow.appendChild(style);
  shadow.appendChild(wrap);

  function scrollToBottom() {
    try {
      log.scrollTop = log.scrollHeight;
    } catch {}
  }

  bubble.addEventListener("click", () => {
    if (layout === "page") return;
    open = !open;
    panel.classList.toggle("open", open);
    cb.onToggleOpen(open);
  });

  let currentMode: "voice" | "text" = "voice";
  let micMuted = false;
  let speakerMuted = false;
  const micSvg = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" stroke="#111827" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M19 11a7 7 0 0 1-14 0" stroke="#111827" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 18v3" stroke="#111827" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M8 21h8" stroke="#111827" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  const micOffSvg = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M9 10v1a3 3 0 0 0 5.12 2.12" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M15 9V6a3 3 0 0 0-5.76-1.24" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M19 11a7 7 0 0 1-7 7c-1.08 0-2.1-.24-3.02-.68" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 18v3" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M8 21h8" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M4 4l16 16" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  const speakerSvg = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M11 5 6 9H3v6h3l5 4V5Z" stroke="#111827" stroke-width="2" stroke-linejoin="round"/>
    <path d="M15.5 8.5a4.5 4.5 0 0 1 0 7" stroke="#111827" stroke-width="2" stroke-linecap="round"/>
    <path d="M17.8 6.2a8 8 0 0 1 0 11.3" stroke="#111827" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
  const speakerOffSvg = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M11 5 6 9H3v6h3l5 4V5Z" stroke="#ef4444" stroke-width="2" stroke-linejoin="round"/>
    <path d="M4 4l16 16" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  function renderMicMuteFor(el: HTMLElement) {
    el.classList.toggle("muted", micMuted);
    el.innerHTML = micMuted ? micOffSvg : micSvg;
    el.setAttribute("aria-pressed", micMuted ? "true" : "false");
    el.setAttribute("aria-label", "Mic");
  }
  function renderSpeakerMuteFor(el: HTMLElement) {
    el.classList.toggle("muted", speakerMuted);
    el.innerHTML = speakerMuted ? speakerOffSvg : speakerSvg;
    el.setAttribute("aria-pressed", speakerMuted ? "true" : "false");
    el.setAttribute("aria-label", "Speaker");
  }
  function renderMutes() {
    renderMicMuteFor(micMuteBtn);
    renderMicMuteFor(footerMicMuteBtn);
    renderSpeakerMuteFor(speakerMuteBtn);
    renderSpeakerMuteFor(footerSpeakerMuteBtn);
  }
  function applyVisibility() {
    const showHistory = currentMode === "text";
    panel.classList.toggle("hideLog", !showHistory);
    panel.classList.toggle("voiceOnly", currentMode === "voice");
    // in voice mode, hide text input completely
    composer.style.display = currentMode === "text" ? "block" : "none";
    // Mic mute only matters in voice mode; Speaker mute should be available in both modes.
    micMuteBtn.style.display = currentMode === "voice" ? "inline-flex" : "none";
    footerMicMuteBtn.style.display = currentMode === "voice" ? "inline-flex" : "none";
    speakerMuteBtn.style.display = "inline-flex";
    footerSpeakerMuteBtn.style.display = "inline-flex";
    renderMutes();
  }

  function applyModeSwitchUi(mode: "voice" | "text") {
    headerMode.input.checked = mode === "text";
    headerMode.root.setAttribute("data-mode", mode);
    headerMode.root.setAttribute("aria-checked", mode === "text" ? "true" : "false");
    footerMode.input.checked = mode === "text";
    footerMode.root.setAttribute("data-mode", mode);
    footerMode.root.setAttribute("aria-checked", mode === "text" ? "true" : "false");
  }

  function setActiveMode(mode: "voice" | "text") {
    applyModeSwitchUi(mode);
    currentMode = mode;
    applyVisibility();
    cb.onSelectMode(mode);
  }

  headerMode.input.addEventListener("change", () => setActiveMode(headerMode.input.checked ? "text" : "voice"));
  footerMode.input.addEventListener("change", () => setActiveMode(footerMode.input.checked ? "text" : "voice"));

  // Make the whole label keyboard-toggle friendly
  function wireSwitchKeyboard(root: HTMLElement, input: HTMLInputElement) {
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        input.checked = !input.checked;
        input.dispatchEvent(new Event("change"));
      }
    });
  }
  wireSwitchKeyboard(headerMode.root, headerMode.input);
  wireSwitchKeyboard(footerMode.root, footerMode.input);

  micMuteBtn.addEventListener("click", () => {
    if (currentMode !== "voice") return;
    micMuted = !micMuted;
    cb.onToggleMicMuted(micMuted);
    renderMutes();
  });
  micMuteBtn.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      micMuteBtn.click();
    }
  });

  footerMicMuteBtn.addEventListener("click", () => {
    if (currentMode !== "voice") return;
    micMuted = !micMuted;
    cb.onToggleMicMuted(micMuted);
    renderMutes();
  });
  footerMicMuteBtn.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      footerMicMuteBtn.click();
    }
  });

  speakerMuteBtn.addEventListener("click", () => {
    speakerMuted = !speakerMuted;
    cb.onToggleSpeakerMuted(speakerMuted);
    renderMutes();
  });
  speakerMuteBtn.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      speakerMuteBtn.click();
    }
  });

  footerSpeakerMuteBtn.addEventListener("click", () => {
    speakerMuted = !speakerMuted;
    cb.onToggleSpeakerMuted(speakerMuted);
    renderMutes();
  });
  footerSpeakerMuteBtn.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      footerSpeakerMuteBtn.click();
    }
  });

  sendBtn.addEventListener("click", () => {
    const t = textarea.value.trim();
    if (!t) return;
    textarea.value = "";
    cb.onSendText(t);
  });
  textarea.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      sendBtn.click();
    }
  });

  consent.addEventListener("click", (ev) => {
    const el = ev.target as HTMLElement | null;
    const act = el?.getAttribute("data-act");
    if (act === "consent-accept") cb.onAcceptConsent();
    if (act === "consent-reject") cb.onRejectConsent();
  });

  // First user gesture hook (for autoplay-restricted audio)
  let gestureFired = false;
  function fireGesture() {
    if (gestureFired) return;
    gestureFired = true;
    cb.onUserGesture();
  }
  wrap.addEventListener("pointerdown", fireGesture, { capture: true });
  wrap.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key === "Enter" || ev.key === " ") fireGesture();
    },
    { capture: true },
  );

  // Listening bars smoothing state (make bars move differently even with same RMS input)
  const barPrev = [0.12, 0.10, 0.08];

  return {
    mount() {
      if (document.getElementById(hostId)) return;
      document.body.appendChild(host);
      if (layout === "page") {
        // page layout is always open
        open = true;
        panel.classList.add("open");
        lockPageScroll(true);
      }
      applyVisibility();
    },
    setOpen(next) {
      open = next;
      panel.classList.toggle("open", open);
    },
    setState(s) {
      status.textContent = s;
      status.classList.toggle("speaking", s === "speaking");
      avatar.classList.toggle("speaking", s === "speaking");
      const voiceUi = (state: WidgetState) => {
        heroAvatar.classList.toggle("speaking", state === "speaking");
        heroAvatar.classList.toggle("listening", state === "listening");
        heroAvatar.classList.toggle("thinking", state === "thinking");
        heroStatusDot.classList.toggle("speaking", state === "speaking");
        heroStatusDot.classList.toggle("listening", state === "listening");
        heroStatusDot.classList.toggle("thinking", state === "thinking");
        const txt = state === "listening" ? "Listening" : state === "thinking" ? "Thinking" : state === "speaking" ? "Speaking" : "Ready";
        heroStatusLabel.textContent = txt;
        // dots for thinking/speaking
        dots.style.display = state === "thinking" || state === "speaking" ? "inline-flex" : "none";
        // Show bars in Ready/Listening so users always see "mic activity" area.
        listenBars.style.display = state === "thinking" || state === "speaking" ? "none" : "inline-flex";
      };
      voiceUi(s);
    },
    setListeningRms(rms) {
      // Map RMS (roughly 0..0.2) into 0..1 for UI.
      const lvl = Math.max(0, Math.min(1, (rms - 0.01) / 0.09));
      const spans = listenBars.querySelectorAll("span");
      // When effectively silent, keep bars steady (no wobble / no motion).
      if (lvl < 0.02) {
        barPrev[0] = 0.12;
        barPrev[1] = 0.10;
        barPrev[2] = 0.08;
        (spans[0] as HTMLElement | undefined)?.style.setProperty("transform", `scaleY(0.12)`);
        (spans[1] as HTMLElement | undefined)?.style.setProperty("transform", `scaleY(0.10)`);
        (spans[2] as HTMLElement | undefined)?.style.setProperty("transform", `scaleY(0.08)`);
        return;
      }
      // Stronger, de-correlated motion:
      // - each bar has its own "wobble" frequency/phase
      // - each bar uses a different smoothing constant (fast/medium/slow)
      // - wobble amplitude is intentionally noticeable
      const t = performance.now() / 1000;
      const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
      const wob = (freq: number, phase: number) => Math.sin(t * freq + phase); // -1..1
      const targets = [
        clamp01(lvl + lvl * 0.28 * wob(9.5, 0.2)),
        clamp01(lvl + lvl * 0.34 * wob(7.2, 2.0)),
        clamp01(lvl + lvl * 0.22 * wob(12.8, 4.1)),
      ];
      const alphas = [0.55, 0.28, 0.16]; // fast/medium/slow
      for (let i = 0; i < 3; i++) {
        barPrev[i] = barPrev[i] + (targets[i] - barPrev[i]) * alphas[i];
      }
      const a = 0.10 + barPrev[0] * 0.90;
      const b = 0.10 + barPrev[1] * 0.90;
      const c = 0.10 + barPrev[2] * 0.90;
      (spans[0] as HTMLElement | undefined)?.style.setProperty("transform", `scaleY(${a.toFixed(3)})`);
      (spans[1] as HTMLElement | undefined)?.style.setProperty("transform", `scaleY(${b.toFixed(3)})`);
      (spans[2] as HTMLElement | undefined)?.style.setProperty("transform", `scaleY(${c.toFixed(3)})`);
    },
    setMode(mode) {
      currentMode = mode;
      applyModeSwitchUi(mode);
      applyVisibility();
    },
    setMicMuted(next) {
      micMuted = next;
      renderMutes();
    },
    setSpeakerMuted(next) {
      speakerMuted = next;
      renderMutes();
    },
    setProfile(profile) {
      currentDisplayName = profile.displayName;
      subEl.textContent = currentIntimacy
        ? `${currentDisplayName} • ${UI_TEXT.intimacyLabel} Lv${currentIntimacy}`
        : currentDisplayName;
      heroName.textContent = profile.displayName;
      if (profile.avatarUrl) avatarImg.src = profile.avatarUrl;
      if (profile.avatarUrl) heroAvatarImg.src = profile.avatarUrl;
    },
    setIntimacy(level) {
      currentIntimacy = level;
      subEl.textContent = currentIntimacy
        ? `${currentDisplayName} • ${UI_TEXT.intimacyLabel} Lv${currentIntimacy}`
        : currentDisplayName;
    },
    appendMessage(role, content) {
      const div = document.createElement("div");
      div.className = `msg ${role}`;
      div.textContent = content;
      log.appendChild(div);
      scrollToBottom();
    },
    setError(msg) {
      if (!msg) {
        error.textContent = "";
        error.classList.remove("show");
        return;
      }
      error.textContent = msg;
      error.classList.add("show");
    },
    setConsentVisible(visible) {
      consent.classList.toggle("show", visible);
    },
    setTextFallbackEnabled(enabled) {
      textarea.disabled = !enabled;
      sendBtn.disabled = !enabled;
    },
  };
}


