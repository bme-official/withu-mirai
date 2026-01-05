import type { WidgetState } from "./stateMachine";
import { UI_TEXT, WIDGET_VERSION } from "./constants";

export type UiLayout = "bubble" | "page";

export type UiCallbacks = {
  onToggleOpen(open: boolean): void;
  onSelectMode(mode: "voice" | "text"): void;
  onSendText(text: string): void;
  onToggleMute(muted: boolean): void;
  onAcceptConsent(): void;
  onRejectConsent(): void;
};

export type UiController = {
  mount(): void;
  setOpen(open: boolean): void;
  setState(state: WidgetState): void;
  setMode(mode: "voice" | "text"): void;
  setProfile(profile: { displayName: string; avatarUrl: string | null }): void;
  setIntimacy(level: number | null): void;
  setMuted(muted: boolean): void;
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
      height: 100vh;
      border-radius: 0;
      margin-bottom: 0;
    }
    .page .header { padding: 16px 16px; }
    .page .log { padding: 16px; }
    .page .footer { padding: 16px; }
    .page .status { display:none; }
    .page .modeTabs { gap: 10px; }
    .page .tab { padding: 8px 12px; font-size: 13px; }
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
      padding: 18px 16px 10px 16px;
      background: linear-gradient(180deg, #f9fafb, rgba(249,250,251,0.0));
      border-bottom: 1px solid rgba(0,0,0,0.06);
      display:flex;
      flex-direction: column;
      align-items:center;
      gap: 10px;
    }
    .page .hero { padding-top: 28px; }
    .heroAvatar {
      width: 116px; height: 116px; border-radius: 9999px;
      overflow:hidden;
      border: 2px solid rgba(0,0,0,0.10);
      box-shadow: 0 20px 45px rgba(0,0,0,0.12);
      background: linear-gradient(135deg, #111827, #6d28d9);
    }
    .heroAvatar.speaking {
      border-color: rgba(109,40,217,0.65);
      box-shadow: 0 0 0 7px rgba(109,40,217,0.18), 0 20px 45px rgba(0,0,0,0.12);
      animation: pulse 1.2s ease-in-out infinite;
    }
    .heroAvatar img { width:100%; height:100%; object-fit:cover; display:block; }
    .heroName { font-weight: 800; font-size: 16px; }
    .heroSub { font-size: 12px; opacity: 0.7; text-align:center; }
    .heroPills { display:flex; gap: 8px; align-items:center; }
    .pill {
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 9999px;
      border: 1px solid rgba(0,0,0,0.10);
      background: rgba(255,255,255,0.9);
    }
    .pill.speaking {
      border-color: rgba(109,40,217,0.25);
      background: rgba(109,40,217,0.10);
      color: #6d28d9;
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
    .muteBtn {
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 9999px;
      border: 1px solid rgba(0,0,0,0.12);
      background: white;
      cursor: pointer;
      user-select:none;
    }
    .muteBtn.active { background: #111827; border-color: #111827; color: white; }
    .tab {
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 9999px;
      border: 1px solid rgba(0,0,0,0.12);
      background: white;
      cursor: pointer;
      user-select:none;
    }
    .tab.active { background: #111827; border-color: #111827; color: white; }
    .log {
      flex: 1;
      overflow: auto;
      padding: 12px;
      display:flex;
      flex-direction: column;
      gap: 10px;
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

  const tabs = document.createElement("div");
  tabs.className = "modeTabs";
  const tabVoice = document.createElement("div");
  tabVoice.className = "tab active";
  tabVoice.textContent = "音声";
  const tabText = document.createElement("div");
  tabText.className = "tab";
  tabText.textContent = "テキスト";
  tabs.appendChild(tabVoice);
  tabs.appendChild(tabText);

  const right = document.createElement("div");
  right.style.display = "flex";
  right.style.alignItems = "center";
  right.style.gap = "8px";
  const muteBtn = document.createElement("div");
  muteBtn.className = "muteBtn";
  muteBtn.textContent = "🔈 ミュート解除";
  right.appendChild(tabs);
  right.appendChild(muteBtn);
  right.appendChild(status);

  header.appendChild(title);
  header.appendChild(right);

  // Page "hero" (center avatar + speaking feel)
  const hero = document.createElement("div");
  hero.className = "hero";
  const heroAvatar = document.createElement("div");
  heroAvatar.className = "heroAvatar";
  const heroAvatarImg = document.createElement("img");
  heroAvatarImg.alt = "avatar";
  heroAvatarImg.src = avatarImg.src;
  heroAvatar.appendChild(heroAvatarImg);

  const heroName = document.createElement("div");
  heroName.className = "heroName";
  heroName.textContent = "Mirai Aizawa";
  const heroSub = document.createElement("div");
  heroSub.className = "heroSub";
  heroSub.textContent = "ここから話しかけてね";

  const heroPills = document.createElement("div");
  heroPills.className = "heroPills";
  const heroStatus = document.createElement("div");
  heroStatus.className = "pill";
  heroStatus.textContent = "idle";
  const heroMode = document.createElement("div");
  heroMode.className = "pill";
  heroMode.textContent = "音声/テキスト";
  heroPills.appendChild(heroMode);
  heroPills.appendChild(heroStatus);

  hero.appendChild(heroAvatar);
  hero.appendChild(heroName);
  hero.appendChild(heroSub);
  hero.appendChild(heroPills);

  const log = document.createElement("div");
  log.className = "log";

  const footer = document.createElement("div");
  footer.className = "footer";

  const error = document.createElement("div");
  error.className = "error";

  const consent = document.createElement("div");
  consent.className = "consent";
  consent.innerHTML = `
    <div><b>録音とログ保存の同意</b></div>
    <div class="small">
      音声会話のためにマイク音声を送信して文字起こしし、会話/イベントログを保存します。<br/>
      同意しない場合、音声開始はできません（テキスト入力は利用できます）。
    </div>
    <div class="row" style="margin-top: 8px;">
      <button data-act="consent-reject">同意しない</button>
      <button class="primary" data-act="consent-accept">同意する</button>
    </div>
  `;

  const textRow = document.createElement("div");
  textRow.className = "row";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "音声が使えない場合はここに入力して送信…";
  textarea.disabled = false;

  const sendBtn = document.createElement("button");
  sendBtn.textContent = "送信";

  textRow.appendChild(textarea);
  textRow.appendChild(sendBtn);

  const meta = document.createElement("div");
  meta.className = "muted";
  meta.textContent = `withu widget v${WIDGET_VERSION}`;

  footer.appendChild(error);
  footer.appendChild(consent);
  footer.appendChild(textRow);
  footer.appendChild(meta);

  panel.appendChild(header);
  panel.appendChild(hero);
  panel.appendChild(log);
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
  let muted = false;
  function applyVisibility() {
    const showHistory = currentMode === "text";
    panel.classList.toggle("hideLog", !showHistory);
    // in voice mode, hide text input completely
    textRow.style.display = currentMode === "text" ? "flex" : "none";
    muteBtn.style.display = currentMode === "voice" ? "inline-flex" : "none";
  }

  function setActiveTab(mode: "voice" | "text") {
    tabVoice.classList.toggle("active", mode === "voice");
    tabText.classList.toggle("active", mode === "text");
    heroMode.textContent = mode === "voice" ? "音声モード" : "テキストモード";
    currentMode = mode;
    applyVisibility();
    cb.onSelectMode(mode);
  }
  tabVoice.addEventListener("click", () => setActiveTab("voice"));
  tabText.addEventListener("click", () => setActiveTab("text"));

  muteBtn.addEventListener("click", () => {
    if (currentMode !== "voice") return;
    muted = !muted;
    muteBtn.classList.toggle("active", muted);
    muteBtn.textContent = muted ? "🔇 ミュート中" : "🔈 ミュート解除";
    cb.onToggleMute(muted);
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

  return {
    mount() {
      if (document.getElementById(hostId)) return;
      document.body.appendChild(host);
      if (layout === "page") {
        // page layout is always open
        open = true;
        panel.classList.add("open");
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
      heroStatus.textContent = s;
      heroStatus.classList.toggle("speaking", s === "speaking");
      heroAvatar.classList.toggle("speaking", s === "speaking");
    },
    setMode(mode) {
      currentMode = mode;
      tabVoice.classList.toggle("active", mode === "voice");
      tabText.classList.toggle("active", mode === "text");
      heroMode.textContent = mode === "voice" ? "音声モード" : "テキストモード";
      applyVisibility();
    },
    setMuted(next) {
      muted = next;
      muteBtn.classList.toggle("active", muted);
      muteBtn.textContent = muted ? "🔇 ミュート中" : "🔈 ミュート解除";
    },
    setProfile(profile) {
      currentDisplayName = profile.displayName;
      subEl.textContent = currentIntimacy ? `${currentDisplayName} • 親密度 Lv${currentIntimacy}` : currentDisplayName;
      heroName.textContent = profile.displayName;
      if (profile.avatarUrl) avatarImg.src = profile.avatarUrl;
      if (profile.avatarUrl) heroAvatarImg.src = profile.avatarUrl;
    },
    setIntimacy(level) {
      currentIntimacy = level;
      subEl.textContent = currentIntimacy ? `${currentDisplayName} • 親密度 Lv${currentIntimacy}` : currentDisplayName;
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


